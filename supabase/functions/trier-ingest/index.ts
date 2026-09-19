// ============================================================================
// trier-ingest — porta de entrada do conector instalado na farmácia
// ----------------------------------------------------------------------------
// Secrets: SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY (automáticos)
//
// Deploy:
//   supabase functions deploy trier-ingest --no-verify-jwt
//
// `--no-verify-jwt` porque quem chama não é um usuário logado: é um processo
// dentro da farmácia, autenticado pela chave de conector (`trier_connectors`).
// A verificação está logo no começo do handler e não tem caminho que a desvie.
//
// ----------------------------------------------------------------------------
// Protocolo (POST JSON, `Authorization: Bearer <chave do conector>`)
//
//   { kind: 'hello', version }
//     → { ok, company, label, cursors, limits }   — handshake; o conector
//       descobre daqui de onde continuar. O cursor mora NO SERVIDOR: trocar o
//       computador da loja não pode disparar backfill de 12 meses de novo.
//
//   { kind, rows: [...DTO cru da Trier...], cursor, done }
//     → { ok, accepted, cursors }
//
//   kind ∈ produtos | estoque | vendas | cancelamentos | pedidos | compras
//
// ----------------------------------------------------------------------------
// Duas decisões que valem o comentário:
//
// 1. O conector manda o JSON CRU da Trier. Toda tradução acontece aqui
//    (`_shared/trier.ts`). Mapeamento errado se conserta com um deploy de Edge
//    Function; se a tradução morasse no conector, se consertaria pedindo a
//    duzentas farmácias que atualizem um programa.
//
// 2. Todo lote é IDEMPOTENTE. Upsert por chave natural no cabeçalho e
//    substituição total dos itens. O conector pode reenviar o mesmo lote depois
//    de um timeout de rede sem duplicar venda — e ele vai, porque a internet de
//    farmácia cai.
// ============================================================================

import { createClient } from 'https://esm.sh/@supabase/supabase-js@2'
import {
  groupItensPedido, mapProduto, mapVenda, matchReceipt, trierDateOnly,
  TRIER_SOURCE, trierProductExternalId,
  type TrierCompra, type TrierEstoque, type TrierItemPedido, type TrierProduto,
  type TrierVenda,
} from '../_shared/trier.ts'

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, content-type',
}

/** Teto por lote. Acima disso o corpo da requisição passa a competir com o
 *  limite de memória da Edge Function, e um lote que falha inteiro é pior que
 *  três que passam. O conector lê este número no handshake. */
const MAX_ROWS = 1000

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, 'Content-Type': 'application/json' },
  })
}

async function sha256Hex(value: string) {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value))
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('')
}

// deno-lint-ignore no-explicit-any
type Admin = any

/**
 * Mapa `sku → product_id` só para os códigos deste lote. Venda de produto que
 * não está no catálogo entra mesmo assim com `product_id` null — demanda de
 * item fora do cadastro continua sendo demanda, e é a tela de Saúde que cobra
 * o conserto. Mesma regra do worker do Tiny.
 */
async function resolveProducts(admin: Admin, companyId: string, codigos: string[]) {
  const map = new Map<string, string>()
  const unique = [...new Set(codigos)].filter(Boolean)
  for (let i = 0; i < unique.length; i += 500) {
    const slice = unique.slice(i, i + 500)
    const { data, error } = await admin
      .from('products')
      .select('id, external_id')
      .eq('company_id', companyId)
      .in('external_id', slice.map((c) => trierProductExternalId(c)))
    if (error) throw new Error(`products (lookup): ${error.message}`)
    for (const p of data ?? []) {
      map.set(String(p.external_id).replace(/^trier-/, ''), p.id as string)
    }
  }
  return map
}

// ---------------------------------------------------------------------------

async function ingestProdutos(admin: Admin, companyId: string, rows: TrierProduto[]) {
  const mapped = rows.filter((r) => r?.codigo != null).map((r) => mapProduto(r, companyId))
  if (mapped.length === 0) return 0
  const { error } = await admin
    .from('products')
    .upsert(mapped, { onConflict: 'company_id,external_id' })
  if (error) throw new Error(`products: ${error.message}`)
  return mapped.length
}

/**
 * Estoque entra no depósito DESTE conector. O SGF roda por loja e o DTO de
 * estoque não tem campo de filial — o saldo que aquele servidor devolve é o
 * daquela loja e de mais nenhuma. É por isso que o vínculo conector ↔ depósito
 * é obrigatório na 0038: sem ele, duas lojas escreveriam uma por cima da outra.
 */
async function ingestEstoque(
  admin: Admin, companyId: string, warehouseId: string, rows: TrierEstoque[],
) {
  const valid = rows.filter((r) => r?.codigoProduto != null)
  if (valid.length === 0) return 0
  const products = await resolveProducts(admin, companyId, valid.map((r) => String(r.codigoProduto)))

  const stock: Record<string, unknown>[] = []
  for (const r of valid) {
    const productId = products.get(String(r.codigoProduto))
    // Estoque de produto que o catálogo ainda não viu é descartado, não
    // inventado: `product_stock` tem FK para `products`, e o lote de produtos
    // vem antes no ciclo do conector. Na próxima volta ele casa.
    if (!productId) continue
    stock.push({
      product_id: productId,
      warehouse_id: warehouseId,
      company_id: companyId,
      qty: r.quantidadeEstoque ?? 0,
      // A API não expõe reserva; zero é o valor honesto, não um palpite.
      qty_reserved: 0,
    })
  }
  if (stock.length === 0) return 0

  const { error } = await admin
    .from('product_stock')
    .upsert(stock, { onConflict: 'product_id,warehouse_id' })
  if (error) throw new Error(`product_stock: ${error.message}`)
  return stock.length
}

async function ingestVendas(
  admin: Admin, companyId: string, rows: TrierVenda[], isCancellation: boolean,
) {
  const mapped = rows
    .map((r) => mapVenda(r, companyId, isCancellation))
    .filter((m): m is NonNullable<typeof m> => m !== null)
  if (mapped.length === 0) return 0

  const { data: orders, error: ordErr } = await admin
    .from('sales_orders')
    .upsert(mapped.map((m) => m.order), { onConflict: 'company_id,channel,external_id' })
    .select('id, external_id')
  if (ordErr) throw new Error(`sales_orders: ${ordErr.message}`)

  const orderIdByExternal = new Map<string, string>()
  for (const o of orders ?? []) orderIdByExternal.set(String(o.external_id), o.id as string)

  // Substituição total dos itens: reenviar o mesmo lote troca as linhas, não
  // empilha. É o que torna o retry do conector inofensivo.
  const orderIds = [...orderIdByExternal.values()]
  const { error: delErr } = await admin
    .from('sales_order_items').delete().in('order_id', orderIds)
  if (delErr) throw new Error(`sales_order_items (limpeza): ${delErr.message}`)

  const allSkus = mapped.flatMap((m) => m.items.map((i) => i.sku))
  const products = await resolveProducts(admin, companyId, allSkus)

  const items: Record<string, unknown>[] = []
  for (const m of mapped) {
    const orderId = orderIdByExternal.get(String(m.order.external_id))
    if (!orderId) continue
    for (const i of m.items) {
      items.push({ ...i, order_id: orderId, product_id: products.get(i.sku) ?? null })
    }
  }
  if (items.length > 0) {
    const { error: itemErr } = await admin.from('sales_order_items').insert(items)
    if (itemErr) throw new Error(`sales_order_items: ${itemErr.message}`)
  }
  return mapped.length
}

async function ingestPedidos(admin: Admin, companyId: string, rows: TrierItemPedido[]) {
  const grouped = groupItensPedido(rows, companyId)
  if (grouped.length === 0) return 0

  const { data: orders, error: poErr } = await admin
    .from('purchase_orders')
    .upsert(grouped.map((g) => g.order), { onConflict: 'company_id,source,external_id' })
    .select('id, external_id')
  if (poErr) throw new Error(`purchase_orders: ${poErr.message}`)

  const idByExternal = new Map<string, string>()
  for (const o of orders ?? []) idByExternal.set(String(o.external_id), o.id as string)

  const orderIds = [...idByExternal.values()]
  const { error: delErr } = await admin
    .from('purchase_order_items').delete().in('order_id', orderIds)
  if (delErr) throw new Error(`purchase_order_items (limpeza): ${delErr.message}`)

  const skus = grouped.flatMap((g) => g.items.map((i) => String(i.sku)))
  const products = await resolveProducts(admin, companyId, skus)

  const items: Record<string, unknown>[] = []
  for (const g of grouped) {
    const orderId = idByExternal.get(String(g.order.external_id))
    if (!orderId) continue
    for (const i of g.items) {
      items.push({ ...i, order_id: orderId, product_id: products.get(String(i.sku)) ?? null })
    }
  }
  if (items.length > 0) {
    const { error: itemErr } = await admin.from('purchase_order_items').insert(items)
    if (itemErr) throw new Error(`purchase_order_items: ${itemErr.message}`)
  }
  return grouped.length
}

/**
 * Baixa do trânsito pelo que ENTROU na loja.
 *
 * A nota de compra da Trier não carrega o número do pedido — não existe
 * vínculo direto. O casamento é FIFO por (fornecedor, produto): a quantidade
 * recebida abate os pedidos abertos daquele fornecedor para aquele produto, do
 * mais antigo para o mais novo. Ver a justificativa em `_shared/trier.ts`.
 *
 * O que NÃO se faz aqui: recusar a baixa por não ter certeza. Trânsito
 * fantasma é o erro caro — ele soma no `qty_open` que o motor lê e faz a
 * farmácia deixar de comprar um item que já acabou na prateleira.
 */
async function ingestCompras(admin: Admin, companyId: string, rows: TrierCompra[]) {
  const pedidos: { sku: string; qty: number; supplierTag: string | null }[] = []
  for (const compra of rows) {
    for (const item of compra?.itens ?? []) {
      const m = matchReceipt(item, compra.codigoFornecedor)
      if (m.sku && m.qty > 0) pedidos.push({ sku: m.sku, qty: m.qty, supplierTag: m.supplierTag })
    }
  }
  if (pedidos.length === 0) return 0

  const skus = [...new Set(pedidos.map((p) => p.sku))]
  const { data: abertos, error: openErr } = await admin
    .from('purchase_order_items')
    .select('id, sku, qty_ordered, qty_received, category, order_id, purchase_orders!inner(ordered_on, source, status)')
    .eq('company_id', companyId)
    .eq('purchase_orders.source', TRIER_SOURCE)
    .eq('purchase_orders.status', 'open')
    .in('sku', skus)
  if (openErr) throw new Error(`purchase_order_items (abertos): ${openErr.message}`)

  // deno-lint-ignore no-explicit-any
  const candidatos = (abertos ?? []) as any[]
  candidatos.sort((a, b) =>
    String(a.purchase_orders?.ordered_on ?? '').localeCompare(String(b.purchase_orders?.ordered_on ?? ''))
  )

  const updates = new Map<string, { received: number; orderId: string }>()
  let baixados = 0

  for (const p of pedidos) {
    let restante = p.qty
    for (const c of candidatos) {
      if (restante <= 0) break
      if (String(c.sku) !== p.sku) continue
      // Fornecedor diferente não é o mesmo pedido. Sem essa checagem, uma
      // compra de emergência no distribuidor A baixaria o pedido programado do
      // laboratório B, que continua a caminho.
      if (p.supplierTag && c.category && c.category !== p.supplierTag) continue
      const jaBaixado = updates.get(c.id)?.received ?? Number(c.qty_received ?? 0)
      const espaco = Number(c.qty_ordered ?? 0) - jaBaixado
      if (espaco <= 0) continue
      const usar = Math.min(espaco, restante)
      updates.set(c.id, { received: jaBaixado + usar, orderId: c.order_id })
      restante -= usar
      baixados += 1
    }
  }

  for (const [id, { received }] of updates) {
    const { error } = await admin
      .from('purchase_order_items').update({ qty_received: received }).eq('id', id)
    if (error) throw new Error(`purchase_order_items (baixa): ${error.message}`)
  }

  // Pedido cujos itens foram todos atendidos sai do trânsito. `qty_open` é
  // coluna gerada (`greatest(qty_ordered - qty_received, 0)`), então basta
  // reler e fechar — não há aritmética duplicada aqui.
  const ordersTocados = [...new Set([...updates.values()].map((u) => u.orderId))]
  for (const orderId of ordersTocados) {
    const { data: itens } = await admin
      .from('purchase_order_items').select('qty_open').eq('order_id', orderId)
    // deno-lint-ignore no-explicit-any
    const aberto = (itens ?? []).some((i: any) => Number(i.qty_open ?? 0) > 0)
    if (!aberto) {
      await admin.from('purchase_orders').update({ status: 'received' }).eq('id', orderId)
    }
  }

  return baixados
}

/** Carimbo de frescor na tela de Saúde, no fim de cada ciclo do conector. */
async function stampSource(
  admin: Admin, companyId: string, kind: string, coversUntil: string | null,
) {
  const table = kind === 'sales' ? 'sales_order_items'
    : kind === 'in_transit' ? 'purchase_order_items'
      : 'products'
  const query = admin.from(table).select('*', { count: 'exact', head: true }).eq('company_id', companyId)
  if (kind === 'sales') query.eq('shadow', false)
  const { count } = await query

  await admin.from('data_sources').upsert({
    company_id: companyId,
    kind,
    provider: TRIER_SOURCE,
    filename: null,
    row_count: count ?? 0,
    covers_until: coversUntil,
    refreshed_at: new Date().toISOString(),
    refreshed_by: null,
  }, { onConflict: 'company_id,kind' })
}

const SOURCE_KIND: Record<string, string> = {
  produtos: 'products',
  estoque: 'products',
  vendas: 'sales',
  cancelamentos: 'sales',
  pedidos: 'in_transit',
  compras: 'in_transit',
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: corsHeaders })
  if (req.method !== 'POST') return json({ error: 'Método não suportado' }, 405)

  const admin = createClient(
    Deno.env.get('SUPABASE_URL')!,
    Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!,
  )

  const key = (req.headers.get('Authorization') ?? '').replace(/^Bearer\s+/i, '').trim()
  if (!key) return json({ error: 'Chave do conector ausente' }, 401)

  const { data: connector } = await admin
    .from('trier_connectors')
    .select('id, company_id, connection_id, label, warehouse_id, cursors, revoked_at')
    .eq('key_hash', await sha256Hex(key))
    .maybeSingle()
  // Chave desconhecida e chave revogada respondem igual, de propósito: quem
  // está sondando não descobre por aqui que a chave já existiu.
  if (!connector || connector.revoked_at) return json({ error: 'Chave inválida' }, 401)

  let body: Record<string, unknown>
  try {
    body = await req.json()
  } catch {
    return json({ error: 'Corpo inválido' }, 400)
  }

  const kind = String(body.kind ?? '')
  const version = body.version ? String(body.version) : null
  const cursors = (connector.cursors ?? {}) as Record<string, unknown>

  await admin.from('trier_connectors').update({
    last_seen_at: new Date().toISOString(),
    last_version: version,
  }).eq('id', connector.id)

  if (kind === 'hello') {
    return json({
      ok: true,
      company: connector.company_id,
      label: connector.label,
      cursors,
      limits: { maxRows: MAX_ROWS },
    })
  }

  const rows = Array.isArray(body.rows) ? body.rows : []
  if (rows.length > MAX_ROWS) {
    return json({ error: `Lote grande demais (máximo ${MAX_ROWS} registros)` }, 413)
  }

  try {
    let accepted = 0
    switch (kind) {
      case 'produtos':
        accepted = await ingestProdutos(admin, connector.company_id, rows as TrierProduto[])
        break
      case 'estoque':
        accepted = await ingestEstoque(
          admin, connector.company_id, connector.warehouse_id, rows as TrierEstoque[],
        )
        break
      case 'vendas':
        accepted = await ingestVendas(admin, connector.company_id, rows as TrierVenda[], false)
        break
      case 'cancelamentos':
        accepted = await ingestVendas(admin, connector.company_id, rows as TrierVenda[], true)
        break
      case 'pedidos':
        accepted = await ingestPedidos(admin, connector.company_id, rows as TrierItemPedido[])
        break
      case 'compras':
        accepted = await ingestCompras(admin, connector.company_id, rows as TrierCompra[])
        break
      default:
        return json({ error: `Tipo de lote desconhecido: ${kind}` }, 400)
    }

    // O cursor só avança DEPOIS que o lote foi gravado. Se a escrita falhar, o
    // conector reenvia do mesmo ponto na próxima volta — nenhuma venda some
    // porque o cursor tinha andado antes da hora.
    const nextCursors = body.cursor !== undefined
      ? { ...cursors, [kind]: body.cursor }
      : cursors
    await admin.from('trier_connectors').update({
      cursors: nextCursors, last_error: null,
    }).eq('id', connector.id)

    if (body.done === true) {
      const sourceKind = SOURCE_KIND[kind]
      if (sourceKind) {
        const coversUntil = typeof body.cursor === 'string'
          ? trierDateOnly(body.cursor)
          : new Date().toISOString().slice(0, 10)
        await stampSource(admin, connector.company_id, sourceKind, coversUntil)
      }
      await admin.from('integration_connections').update({
        status: 'connected', last_error: null,
      }).eq('id', connector.connection_id)
    }

    return json({ ok: true, accepted, cursors: nextCursors })
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    console.error('trier-ingest', kind, message)
    await admin.from('trier_connectors').update({ last_error: message }).eq('id', connector.id)
    return json({ error: message }, 500)
  }
})
