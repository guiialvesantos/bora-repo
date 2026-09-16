// ============================================================================
// tiny-sync-worker — sincroniza produtos + estoque (fase 2), vendas
// definitivas (fase 3, pós-corte; cancelado fica shadow) e micro-jobs de
// webhook (`stock_single` / `order_single`, tempo real) do Tiny (Olist)
// ----------------------------------------------------------------------------
// Secrets:
//   SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY (auto)
//   TINY_ENCRYPTION_KEY — a mesma do `tiny-connect`
//   TINY_SYNC_SECRET     — opcional, Bearer do cron; sem ele aceita service role
//
// Deploy:
//   supabase functions deploy tiny-sync-worker --no-verify-jwt
//   (cron a cada minuto chamando este endpoint sem body)
//
// ----------------------------------------------------------------------------
// Mesma forma do `stripe-sync` do cockpit: um orçamento de tempo por invocação
// (Edge Function morre em ~150s), cursor salvo em `sync_runs.cursor` a cada
// página, e devolve `done: false` para quem chamou reinvocar. Aqui o cursor é
// o número da página de `produtos.pesquisa` — o Tiny pagina, não oferece
// "continue a partir deste id".
//
// Fase 2 só sincroniza produto + estoque: são endpoints pequenos e sem N+1.
// Pedido (fase 3) é outra história — o list de pedidos da v2 não traz os
// itens, então cada pedido custa uma chamada extra, e isso é fila, não budget.
//
// Um job por vez (`sync_jobs_claim`, `FOR UPDATE SKIP LOCKED`): dois crons
// disparando junto nunca processam o mesmo job.
// ============================================================================

import { createClient } from 'https://esm.sh/@supabase/supabase-js@2'
import { decryptSecret, deriveKey } from '../_shared/crypto.ts'
import {
  lastKnownLimitPerMinute, TinyApiError, TinyRateLimitedError, TinyTooManyRecordsError,
  tinyListarProdutos, tinyObterEstoque, tinyObterPedido, tinyObterProduto, tinyPesquisarPedidos,
} from '../_shared/tiny.ts'
import { loadRateLimit, saveRateLimit, TokenBucket } from '../_shared/rate-limit.ts'
import {
  ensureFreshAccess, lastKnownV3LimitPerMinute, TinyV3ApiError, TinyV3AuthError,
  tinyV3ListarOrdensCompra, tinyV3ListarProdutos, tinyV3ObterEstoque,
  tinyV3ObterOrdemCompra, tinyV3ObterPedido, tinyV3ObterProduto, tinyV3ObterTagsProduto,
  tinyV3PesquisarPedidos, type TinyV3Secret,
} from '../_shared/tiny-v3.ts'

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
}

/** Deixa folga para gravar o cursor e responder antes do corte da plataforma. */
const BUDGET_MS = 100_000

function json(data: unknown, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { ...corsHeaders, 'Content-Type': 'application/json' },
  })
}

// ---------------------------------------------------------------------------
// Cliente por provider — v2 (token de query string) e v3 (Bearer OAuth) atrás
// da mesma interface, nas formas que os processadores já consomem. Datas
// cruzam a interface SEMPRE em ISO `yyyy-MM-dd`; o adaptador v2 é quem
// converte de/para dd/mm/yyyy.
// ---------------------------------------------------------------------------

interface TinyClient {
  provider: 'tiny_v2' | 'tiny_v3'
  listarProdutos(pagina: number): Promise<{
    produtos: { id: string; codigo: string | null; nome: string; situacao: string }[]
    numeroPaginas: number
  }>
  obterProduto(id: string): Promise<{
    id: string; codigo: string | null; nome: string
    preco: number; precoCusto: number; imageUrl: string | null
    categoria?: string | null; marca?: string | null
    // Grade (pai ↔ variação) só existe na v3, como categoria e marca: o v2
    // deixa indefinido e o upsert não toca nas colunas.
    tipoVariacao?: string; paiId?: string | null
  }>
  // `reservado` (peças em pedidos de venda abertos) só existe na v3; o v2
  // omite e o sync grava 0 — saldo e disponível coincidem na Triana.
  obterEstoque(id: string): Promise<{ externalName: string; saldo: number; reservado?: number }[]>
  // Tags só existem na v3 (endpoint próprio, 3ª chamada por produto). O v2
  // deixa indefinido e o sync simplesmente não escreve a coluna.
  obterTags?(id: string): Promise<string[]>
  pesquisarPedidos(dataInicialIso: string, dataFinalIso: string, pagina: number): Promise<{
    pedidos: { id: string }[]
    numeroPaginas: number
  }>
  obterPedido(id: string): Promise<{
    id: string; numero: string | null; soldOn: string; situacao: string
    itens: { codigo: string | null; quantidade: number; valorUnitario: number }[]
  }>
  isRateLimited(err: unknown): boolean
  planLimit(): number | null
  // Ordens de compra existem SÓ na v3 — o cliente v2 deixa indefinido e o
  // processador falha claro em vez de fingir que sincronizou.
  listarOrdensCompra?(situacao: number, pagina: number): Promise<{
    ids: string[]
    numeroPaginas: number
  }>
  obterOrdemCompra?(id: string): Promise<{
    id: string; numero: string | null; orderedOn: string; situacao: number
    etaOn: string | null; fornecedor: string | null
    itens: { sku: string | null; quantidade: number; preco: number }[]
  }>
}

const isoToBr = (iso: string) => { const [y, m, d] = iso.split('-'); return `${d}/${m}/${y}` }
const brToIso = (br: string) => { const [d, m, y] = br.split('/'); return `${y}-${m}-${d}` }

function makeV2Client(token: string): TinyClient {
  const conn = { token }
  return {
    provider: 'tiny_v2',
    listarProdutos: (pagina) => tinyListarProdutos(conn, pagina),
    obterProduto: (id) => tinyObterProduto(conn, id),
    obterEstoque: (id) => tinyObterEstoque(conn, id),
    pesquisarPedidos: (ini, fim, pagina) =>
      tinyPesquisarPedidos(conn, isoToBr(ini), isoToBr(fim), pagina),
    obterPedido: async (id) => {
      const p = await tinyObterPedido(conn, id)
      return { ...p, soldOn: brToIso(p.dataPedido) }
    },
    isRateLimited: (err) =>
      err instanceof TinyRateLimitedError || (err instanceof TinyApiError && err.codigo === '429'),
    planLimit: () => lastKnownLimitPerMinute,
  }
}

function makeV3Client(accessToken: string): TinyClient {
  return {
    provider: 'tiny_v3',
    listarProdutos: (pagina) => tinyV3ListarProdutos(accessToken, pagina),
    obterProduto: (id) => tinyV3ObterProduto(accessToken, id),
    obterEstoque: (id) => tinyV3ObterEstoque(accessToken, id),
    pesquisarPedidos: (ini, fim, pagina) => tinyV3PesquisarPedidos(accessToken, ini, fim, pagina),
    obterPedido: (id) => tinyV3ObterPedido(accessToken, id),
    isRateLimited: (err) => err instanceof TinyV3ApiError && err.status === 429,
    planLimit: () => lastKnownV3LimitPerMinute,
    listarOrdensCompra: (situacao, pagina) =>
      tinyV3ListarOrdensCompra(accessToken, situacao, pagina),
    obterOrdemCompra: (id) => tinyV3ObterOrdemCompra(accessToken, id),
    obterTags: (id) => tinyV3ObterTagsProduto(accessToken, id),
  }
}

// ---------------------------------------------------------------------------
// Estoque por depósito — "todo estoque está em algum depósito" (Loghouse,
// Devoluções, geral…). Cada depósito do Tiny vira uma linha em `warehouses`
// (chaveada por nome normalizado) e o saldo grava POR depósito, não somado.
// O disponível do motor continua sendo a soma dos depósitos com
// `include_in_available = true` (default), então o total não muda — mas abre
// a porta para excluir um depósito (ex.: devoluções avariadas) sem tocar no
// motor. Linhas de depósitos que sumiram da resposta (inclusive o agregado
// legado "Tiny (Olist)") são removidas por produto.
// ---------------------------------------------------------------------------

const depositoSlug = (name: string) =>
  name.trim().toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '') || 'sem-nome'

// deno-lint-ignore no-explicit-any
async function upsertStockByDeposit(
  // deno-lint-ignore no-explicit-any
  admin: any,
  companyId: string,
  productId: string,
  estoque: { externalName: string; saldo: number; reservado?: number }[],
  warehouseCache: Map<string, string>,
) {
  // Mesmo nome duas vezes (multi-empresa do Tiny) soma no mesmo depósito.
  const porNome = new Map<string, { saldo: number; reservado: number }>()
  for (const d of estoque) {
    const nome = d.externalName.trim() || 'Tiny'
    const acc = porNome.get(nome) ?? { saldo: 0, reservado: 0 }
    acc.saldo += d.saldo
    acc.reservado += d.reservado ?? 0
    porNome.set(nome, acc)
  }
  if (porNome.size === 0) porNome.set('Tiny', { saldo: 0, reservado: 0 })

  const keep: string[] = []
  for (const [nome, { saldo, reservado }] of porNome) {
    let warehouseId = warehouseCache.get(nome)
    if (!warehouseId) {
      const { data: wh, error: whErr } = await admin
        .from('warehouses')
        .upsert(
          { company_id: companyId, external_id: `tiny-dep-${depositoSlug(nome)}`, name: nome },
          { onConflict: 'company_id,external_id' },
        )
        .select('id')
        .single()
      if (whErr) throw new Error(`warehouses: ${whErr.message}`)
      warehouseId = wh.id as string
      warehouseCache.set(nome, warehouseId)
    }
    const { error: psErr } = await admin.from('product_stock').upsert(
      {
        product_id: productId, warehouse_id: warehouseId, company_id: companyId,
        qty: saldo, qty_reserved: reservado,
      },
      { onConflict: 'product_id,warehouse_id' },
    )
    if (psErr) throw new Error(`product_stock: ${psErr.message}`)
    keep.push(warehouseId)
  }

  const { error: delErr } = await admin
    .from('product_stock')
    .delete()
    .eq('product_id', productId)
    .not('warehouse_id', 'in', `(${keep.join(',')})`)
  if (delErr) throw new Error(`product_stock (limpeza): ${delErr.message}`)
}

/**
 * HTTP 429 é pressão, não falha: o job volta à fila com 5 min de espera e a
 * conexão fica intacta. Marcar a conexão como `error` num 429 mata a renovação
 * de token (maintainV3Tokens só olha `connected`) — foi exatamente o espiral
 * que derrubou a All Out em 14/09/2026. Devolve true se era 429 e foi tratado.
 */
// deno-lint-ignore no-explicit-any
async function requeueIfRateLimited(admin: any, job: any, message: string): Promise<boolean> {
  if (!/HTTP 429/.test(message)) return false
  await admin.from('sync_jobs').update({
    status: 'queued',
    last_error: message,
    run_after: new Date(Date.now() + 5 * 60 * 1000).toISOString(),
  }).eq('id', job.id)
  return true
}

// deno-lint-ignore no-explicit-any
async function processProductsStock(admin: any, job: any, client: TinyClient, startedAt: number) {
  const bucket = new TokenBucket(await loadRateLimit(admin, job.connection_id))
  let calls = 0
  const persistBucket = async () => saveRateLimit(admin, job.connection_id, bucket.snapshot)

  const { data: runRow } = await admin
    .from('sync_runs')
    .insert({
      company_id: job.company_id,
      connection_id: job.connection_id,
      kind: 'products_stock',
      resource: 'produtos',
      cursor: job.payload?.pagina ? String(job.payload.pagina) : '1',
    })
    .select('id')
    .single()

  let pagina = Number(job.payload?.pagina ?? 1)
  // Offset dentro da página atual: o orçamento de tempo quase sempre estoura
  // no meio de uma página (~100 produtos, 2 chamadas cada), não na borda dela
  // — sem isto, um job pausado sempre recomeça a página do zero e nunca
  // termina de verdade quando o rate limit está apertado.
  let offset = Number(job.payload?.offset ?? 0)
  let processed = 0
  let done = false
  let lastError: string | null = null
  let coversUntil: string | null = null

  async function call<T>(fn: () => Promise<T>): Promise<T> {
    for (;;) {
      await bucket.take()
      calls += 1
      try {
        const result = await fn()
        // Toda resposta do Tiny traz o limite real do plano (x-limit-api na
        // v2, X-RateLimit-Limit na v3) — calibra o bucket por ele em vez de
        // só aprender por tentativa e erro.
        const planLimit = client.planLimit()
        if (planLimit != null) bucket.calibrateToPlanLimit(planLimit)
        bucket.onSuccess()
        if (calls % 20 === 0) await persistBucket()
        return result
      } catch (err) {
        if (client.isRateLimited(err)) {
          bucket.onRateLimited()
          await persistBucket()
          continue
        }
        throw err
      }
    }
  }

  try {
    const warehouseCache = new Map<string, string>()

    outer: while (Date.now() - startedAt < BUDGET_MS) {
      const page = await call(() => client.listarProdutos(pagina))

      for (const resumo of page.produtos.slice(offset)) {
        if (Date.now() - startedAt >= BUDGET_MS) break outer

        const detalhe = await call(() => client.obterProduto(resumo.id))
        const estoque = await call(() => client.obterEstoque(resumo.id))
        const tags = client.obterTags ? await call(() => client.obterTags!(resumo.id)) : null

        const { data: product, error: prodErr } = await admin
          .from('products')
          .upsert(
            {
              company_id: job.company_id,
              external_id: `tiny-${detalhe.id}`,
              sku: detalhe.codigo,
              name: detalhe.nome,
              sale_price: detalhe.preco,
              cmv: detalhe.precoCusto || null,
              image_url: detalhe.imageUrl,
              is_active: resumo.situacao !== 'Excluido' && resumo.situacao !== 'Inativo',
              // v2 não tem tags/categoria/marca — as chaves ficam de fora e o
              // upsert não toca nas colunas.
              ...(tags != null ? { tags } : {}),
              ...(detalhe.categoria !== undefined ? { category: detalhe.categoria } : {}),
              ...(detalhe.marca !== undefined ? { brand: detalhe.marca } : {}),
              ...(detalhe.tipoVariacao !== undefined
                ? {
                  variation_type: detalhe.tipoVariacao,
                  // Mesmo prefixo de `external_id` para casar sem remontar.
                  parent_external_id: detalhe.paiId ? `tiny-${detalhe.paiId}` : null,
                }
                : {}),
            },
            { onConflict: 'company_id,external_id' },
          )
          .select('id')
          .single()
        if (prodErr) throw new Error(`products: ${prodErr.message}`)

        await upsertStockByDeposit(admin, job.company_id, product.id, estoque, warehouseCache)

        processed += 1
        offset += 1
      }

      if (pagina >= page.numeroPaginas) { done = true; break outer }
      pagina += 1
      offset = 0
    }
  } catch (err) {
    lastError = err instanceof Error ? err.message : String(err)
  }

  await persistBucket()
  coversUntil = new Date().toISOString().slice(0, 10)

  if (runRow?.id) {
    await admin.from('sync_runs').update({
      status: lastError ? 'error' : (done ? 'done' : 'paused'),
      cursor: String(pagina),
      processed,
      error: lastError,
      finished_at: new Date().toISOString(),
    }).eq('id', runRow.id)
  }

  if (lastError) {
    if (await requeueIfRateLimited(admin, job, lastError)) {
      return { done: false, processed, error: null }
    }
    await admin.from('sync_jobs').update({
      status: 'error', last_error: lastError,
    }).eq('id', job.id)
    await admin.from('integration_connections').update({
      status: 'error', last_error: lastError,
    }).eq('id', job.connection_id)
    return { done: false, processed, error: lastError }
  }

  if (done) {
    await admin.from('sync_jobs').update({ status: 'done' }).eq('id', job.id)
    await admin.from('data_sources').upsert({
      company_id: job.company_id,
      kind: 'products',
      provider: client.provider,
      filename: null,
      row_count: processed,
      covers_until: coversUntil,
      refreshed_at: new Date().toISOString(),
      refreshed_by: null,
    }, { onConflict: 'company_id,kind' })
  } else {
    // Não terminou dentro do orçamento: devolve o MESMO job à fila, do ponto
    // onde parou, em vez de marcar erro. É o que torna o sync retomável.
    await admin.from('sync_jobs').update({
      status: 'queued', payload: { pagina, offset }, run_after: new Date().toISOString(),
    }).eq('id', job.id)
  }

  return { done, processed, error: null }
}

// ---------------------------------------------------------------------------
// Vendas (fase 3 — corte feito em 12/09/2026)
//
// O list de pedidos da v2 não traz item nenhum: cada pedido custa um
// `pedido.obter` (o N+1). Desde o corte, venda entra DEFINITIVA
// (`shadow = false`) — exceto pedido cancelado, que fica `shadow = true` e
// não alimenta o motor. O diff do shadow provou que o export histórico da
// planilha contava cancelado como demanda; a regra oficial é: não conta.
// Cancelamento tardio dentro da janela de 7 dias do delta é rebaixado de
// volta a shadow pelo reprocessamento (upsert do cabeçalho + delete/insert
// dos itens). Cancelamento além dessa janela só entra quando houver webhook.
//
// O backfill anda em janelas fixas de datas (default 30 dias) porque o filtro
// da v2 estoura em "excesso de registros" (codigo 21) para janelas grandes —
// quando estoura, a janela cai pela metade e tenta de novo. O cursor é
// {windowStart, windowDays, pagina, offset}.
//
// Ao terminar o backfill, enfileira um job delta que se re-agenda sozinho a
// cada 30 min cobrindo os últimos 7 dias — pedido editado/cancelado dentro da
// janela é reprocessado (delete+insert dos itens, upsert do cabeçalho).
// ---------------------------------------------------------------------------

// deno-lint-ignore no-explicit-any
async function processOrders(admin: any, job: any, client: TinyClient, startedAt: number) {
  const bucket = new TokenBucket(await loadRateLimit(admin, job.connection_id))
  let calls = 0
  const persistBucket = async () => saveRateLimit(admin, job.connection_id, bucket.snapshot)

  const toIso = (d: Date) => d.toISOString().slice(0, 10)
  const addDays = (iso: string, n: number) => {
    const d = new Date(`${iso}T00:00:00Z`)
    d.setUTCDate(d.getUTCDate() + n)
    return toIso(d)
  }

  const isDelta = job.payload?.delta === true
  const todayIso = toIso(new Date())
  // Delta recobre 7 dias: pega edição e cancelamento recente. Backfill: 12 meses.
  const endDate: string = job.payload?.endDate ?? todayIso
  let windowStart: string = job.payload?.windowStart ??
    (isDelta ? addDays(todayIso, -7) : addDays(todayIso, -365))
  let windowDays = Math.max(1, Number(job.payload?.windowDays ?? (isDelta ? 8 : 30)))
  let pagina = Number(job.payload?.pagina ?? 1)
  let offset = Number(job.payload?.offset ?? 0)
  let processed = 0
  let done = false
  let lastError: string | null = null

  const { data: runRow } = await admin
    .from('sync_runs')
    .insert({
      company_id: job.company_id,
      connection_id: job.connection_id,
      kind: 'orders',
      resource: isDelta ? 'pedidos (delta)' : 'pedidos',
      cursor: `${windowStart} p${pagina}`,
    })
    .select('id')
    .single()

  async function call<T>(fn: () => Promise<T>): Promise<T> {
    for (;;) {
      await bucket.take()
      calls += 1
      try {
        const result = await fn()
        if (lastKnownLimitPerMinute != null) bucket.calibrateToPlanLimit(lastKnownLimitPerMinute)
        bucket.onSuccess()
        if (calls % 20 === 0) await persistBucket()
        return result
      } catch (err) {
        if (err instanceof TinyRateLimitedError || (err instanceof TinyApiError && err.codigo === '429')) {
          bucket.onRateLimited()
          await persistBucket()
          continue
        }
        throw err
      }
    }
  }

  try {
    // Mapa sku_norm → product_id, para casar item de venda com produto. Venda
    // de SKU sem produto entra mesmo assim (product_id null): demanda de item
    // fora do catálogo continua sendo demanda.
    const skuMap = new Map<string, string>()
    for (let from = 0; ; from += 1000) {
      const { data: prods, error: prodErr } = await admin
        .from('products')
        .select('id, sku')
        .eq('company_id', job.company_id)
        .range(from, from + 999)
      if (prodErr) throw new Error(`products: ${prodErr.message}`)
      for (const p of prods ?? []) {
        const norm = typeof p.sku === 'string' ? p.sku.trim().toUpperCase() : ''
        if (norm) skuMap.set(norm, p.id)
      }
      if (!prods || prods.length < 1000) break
    }

    outer: while (Date.now() - startedAt < BUDGET_MS) {
      if (windowStart > endDate) { done = true; break }
      const candidateEnd = addDays(windowStart, windowDays - 1)
      const windowEnd = candidateEnd > endDate ? endDate : candidateEnd

      let page
      try {
        page = await call(() => client.pesquisarPedidos(windowStart, windowEnd, pagina))
      } catch (err) {
        if (err instanceof TinyTooManyRecordsError && windowDays > 1) {
          windowDays = Math.max(1, Math.floor(windowDays / 2))
          pagina = 1
          offset = 0
          continue
        }
        throw err
      }

      for (const resumo of page.pedidos.slice(offset)) {
        if (Date.now() - startedAt >= BUDGET_MS) break outer

        const detalhe = await call(() => client.obterPedido(resumo.id))
        const soldOn = detalhe.soldOn
        // Pós-corte: só cancelado fica fora do motor. O delta reprocessa o
        // pedido inteiro, então cancelar dentro de 7 dias rebaixa a venda.
        const isShadow = detalhe.situacao === 'Cancelado'

        const { data: order, error: ordErr } = await admin
          .from('sales_orders')
          .upsert(
            {
              company_id: job.company_id,
              external_id: `tiny-${detalhe.id}`,
              channel: 'olist',
              number: detalhe.numero,
              status: detalhe.situacao,
              // A v2 só dá a data local do pedido; meio-dia em São Paulo evita
              // qualquer escorregão de fuso. `sold_on` é a coluna que manda.
              ordered_at: `${soldOn}T12:00:00-03:00`,
              sold_on: soldOn,
              items_fetched: true,
              shadow: isShadow,
            },
            { onConflict: 'company_id,channel,external_id' },
          )
          .select('id')
          .single()
        if (ordErr) throw new Error(`sales_orders: ${ordErr.message}`)

        // Idempotência por pedido: reprocessar substitui os itens, não duplica.
        const { error: delErr } = await admin
          .from('sales_order_items').delete().eq('order_id', order.id)
        if (delErr) throw new Error(`sales_order_items delete: ${delErr.message}`)

        if (detalhe.itens.length > 0) {
          const { error: itemErr } = await admin.from('sales_order_items').insert(
            // deno-lint-ignore no-explicit-any
            detalhe.itens.map((i: any) => ({
              company_id: job.company_id,
              order_id: order.id,
              product_id: i.codigo ? (skuMap.get(String(i.codigo).trim().toUpperCase()) ?? null) : null,
              sku: i.codigo,
              qty: i.quantidade,
              unit_price: i.valorUnitario,
              sold_on: soldOn,
              shadow: isShadow,
            })),
          )
          if (itemErr) throw new Error(`sales_order_items: ${itemErr.message}`)
        }

        processed += 1
        offset += 1
      }

      if (pagina >= page.numeroPaginas || page.pedidos.length === 0) {
        windowStart = addDays(windowEnd, 1)
        pagina = 1
        offset = 0
        if (windowStart > endDate) { done = true; break outer }
      } else {
        pagina += 1
        offset = 0
      }
    }
  } catch (err) {
    lastError = err instanceof Error ? err.message : String(err)
  }

  await persistBucket()

  if (runRow?.id) {
    await admin.from('sync_runs').update({
      status: lastError ? 'error' : (done ? 'done' : 'paused'),
      cursor: `${windowStart} p${pagina}`,
      processed,
      error: lastError,
      finished_at: new Date().toISOString(),
    }).eq('id', runRow.id)
  }

  if (lastError) {
    if (await requeueIfRateLimited(admin, job, lastError)) {
      return { done: false, processed, error: null }
    }
    await admin.from('sync_jobs').update({
      status: 'error', last_error: lastError,
    }).eq('id', job.id)
    await admin.from('integration_connections').update({
      status: 'error', last_error: lastError,
    }).eq('id', job.connection_id)
    return { done: false, processed, error: lastError }
  }

  // Pós-corte a venda ingerida alimenta o motor na hora, então a fonte é
  // carimbada em toda rodada sem erro que processou algo — a tela de saúde
  // deixa de depender do fim do backfill para dizer a verdade.
  if (processed > 0) await stampSalesSource(admin, job.company_id, client.provider)

  if (!done) {
    // Estourou o orçamento: devolve o MESMO job à fila do ponto onde parou.
    await admin.from('sync_jobs').update({
      status: 'queued',
      payload: { windowStart, endDate, windowDays, pagina, offset, delta: isDelta },
      run_after: new Date().toISOString(),
    }).eq('id', job.id)
    return { done, processed, error: null }
  }

  if (isDelta) {
    // O delta se re-agenda sozinho: o mesmo job volta à fila com payload limpo
    // (a janela de 7 dias é recomputada a cada rodada) e run_after +30 min.
    await admin.from('sync_jobs').update({
      status: 'queued',
      payload: { delta: true },
      run_after: new Date(Date.now() + 30 * 60 * 1000).toISOString(),
    }).eq('id', job.id)
  } else {
    await admin.from('sync_jobs').update({ status: 'done' }).eq('id', job.id)
    // Backfill completo → nasce o delta recorrente. Insert simples ignorando
    // 23505: upsert com onConflict não enxerga o índice único PARCIAL de
    // dedupe (where status in queued/running) e falharia com 42P10.
    const { error: deltaErr } = await admin.from('sync_jobs').insert({
      company_id: job.company_id,
      connection_id: job.connection_id,
      kind: 'orders',
      payload: { delta: true },
      priority: 100,
      dedupe_key: `${job.company_id}:orders:delta`,
      run_after: new Date(Date.now() + 30 * 60 * 1000).toISOString(),
    })
    if (deltaErr && deltaErr.code !== '23505') {
      console.error('tiny-sync-worker: falha ao enfileirar delta', deltaErr.message)
    }
  }

  return { done, processed, error: null }
}

/**
 * Carimbo da fonte de vendas em `data_sources` — contagem e última data só
 * das linhas definitivas (`shadow = false`), que são as que o motor enxerga.
 */
// deno-lint-ignore no-explicit-any
async function stampSalesSource(admin: any, companyId: string, provider: string) {
  const { count: rowCount } = await admin
    .from('sales_order_items')
    .select('*', { count: 'exact', head: true })
    .eq('company_id', companyId)
    .eq('shadow', false)
  const { data: lastSale } = await admin
    .from('sales_order_items')
    .select('sold_on')
    .eq('company_id', companyId)
    .eq('shadow', false)
    .order('sold_on', { ascending: false })
    .limit(1)
  await admin.from('data_sources').upsert({
    company_id: companyId,
    kind: 'sales',
    provider,
    filename: null,
    row_count: rowCount ?? 0,
    covers_until: lastSale?.[0]?.sold_on ?? null,
    refreshed_at: new Date().toISOString(),
    refreshed_by: null,
  }, { onConflict: 'company_id,kind' })
}

// ---------------------------------------------------------------------------
// Micro-jobs de webhook (tempo real)
//
// O `tiny-webhook` não confia no corpo do aviso: o payload do evento é só o
// gatilho, a verdade vem sempre da API (`produto.obter.estoque` /
// `pedido.obter`). Por isso os jobs carregam apenas o id do Tiny — reprocessar
// o mesmo evento é idempotente (upsert / delete+insert).
//
// `order_single` também fecha a lacuna do cancelamento tardio: o Tiny avisa a
// mudança de situação e o pedido é rebaixado a shadow na hora, sem depender da
// janela de 7 dias do delta.
// ---------------------------------------------------------------------------

/** Retry de rate limit para jobs de 2–3 chamadas — sem cursor, sem orçamento. */
function makeSingleCall(bucket: TokenBucket, client: TinyClient) {
  return async function call<T>(fn: () => Promise<T>): Promise<T> {
    for (;;) {
      await bucket.take()
      try {
        const result = await fn()
        const planLimit = client.planLimit()
        if (planLimit != null) bucket.calibrateToPlanLimit(planLimit)
        bucket.onSuccess()
        return result
      } catch (err) {
        if (client.isRateLimited(err)) {
          bucket.onRateLimited()
          continue
        }
        throw err
      }
    }
  }
}

// deno-lint-ignore no-explicit-any
async function processStockSingle(admin: any, job: any, client: TinyClient) {
  const tinyProductId = String(job.payload?.tinyProductId ?? '')
  if (!tinyProductId) {
    await admin.from('sync_jobs').update({ status: 'error', last_error: 'payload sem tinyProductId' }).eq('id', job.id)
    return { done: false, processed: 0, error: 'payload sem tinyProductId' }
  }

  const bucket = new TokenBucket(await loadRateLimit(admin, job.connection_id))
  const call = makeSingleCall(bucket, client)

  try {
    const detalhe = await call(() => client.obterProduto(tinyProductId))
    const estoque = await call(() => client.obterEstoque(tinyProductId))
    const tags = client.obterTags ? await call(() => client.obterTags!(tinyProductId)) : null

    // `is_active` fica de fora de propósito: o aviso de estoque não traz a
    // situação do produto, e o upsert só sobrescreve as colunas presentes.
    const { data: product, error: prodErr } = await admin
      .from('products')
      .upsert(
        {
          company_id: job.company_id,
          external_id: `tiny-${detalhe.id}`,
          sku: detalhe.codigo,
          name: detalhe.nome,
          sale_price: detalhe.preco,
          cmv: detalhe.precoCusto || null,
          image_url: detalhe.imageUrl,
          ...(tags != null ? { tags } : {}),
          ...(detalhe.categoria !== undefined ? { category: detalhe.categoria } : {}),
          ...(detalhe.marca !== undefined ? { brand: detalhe.marca } : {}),
        },
        { onConflict: 'company_id,external_id' },
      )
      .select('id')
      .single()
    if (prodErr) throw new Error(`products: ${prodErr.message}`)

    await upsertStockByDeposit(admin, job.company_id, product.id, estoque, new Map())

    // Só o frescor — `row_count`/`covers_until` continuam sendo do sync completo.
    await admin.from('data_sources')
      .update({ refreshed_at: new Date().toISOString() })
      .eq('company_id', job.company_id)
      .eq('kind', 'products')

    await admin.from('sync_jobs').update({ status: 'done' }).eq('id', job.id)
    return { done: true, processed: 1, error: null }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    if (await requeueIfRateLimited(admin, job, message)) {
      return { done: false, processed: 0, error: null }
    }
    await admin.from('sync_jobs').update({ status: 'error', last_error: message }).eq('id', job.id)
    return { done: false, processed: 0, error: message }
  } finally {
    await saveRateLimit(admin, job.connection_id, bucket.snapshot)
  }
}

// deno-lint-ignore no-explicit-any
async function processOrderSingle(admin: any, job: any, client: TinyClient) {
  const tinyOrderId = String(job.payload?.tinyOrderId ?? '')
  if (!tinyOrderId) {
    await admin.from('sync_jobs').update({ status: 'error', last_error: 'payload sem tinyOrderId' }).eq('id', job.id)
    return { done: false, processed: 0, error: 'payload sem tinyOrderId' }
  }

  const bucket = new TokenBucket(await loadRateLimit(admin, job.connection_id))
  const call = makeSingleCall(bucket, client)

  try {
    const detalhe = await call(() => client.obterPedido(tinyOrderId))
    const soldOn = detalhe.soldOn
    // Mesma regra do delta: só cancelado fica fora do motor.
    const isShadow = detalhe.situacao === 'Cancelado'

    const { data: order, error: ordErr } = await admin
      .from('sales_orders')
      .upsert(
        {
          company_id: job.company_id,
          external_id: `tiny-${detalhe.id}`,
          channel: 'olist',
          number: detalhe.numero,
          status: detalhe.situacao,
          ordered_at: `${soldOn}T12:00:00-03:00`,
          sold_on: soldOn,
          items_fetched: true,
          shadow: isShadow,
        },
        { onConflict: 'company_id,channel,external_id' },
      )
      .select('id')
      .single()
    if (ordErr) throw new Error(`sales_orders: ${ordErr.message}`)

    const { error: delErr } = await admin
      .from('sales_order_items').delete().eq('order_id', order.id)
    if (delErr) throw new Error(`sales_order_items delete: ${delErr.message}`)

    if (detalhe.itens.length > 0) {
      // Um pedido tem meia dúzia de itens: lookup por sku_norm direto no banco
      // em vez de carregar o catálogo inteiro como faz o backfill.
      const rows: Record<string, unknown>[] = []
      for (const i of detalhe.itens) {
        const norm = i.codigo ? String(i.codigo).trim().toUpperCase() : ''
        let productId: string | null = null
        if (norm) {
          const { data: match } = await admin
            .from('products')
            .select('id')
            .eq('company_id', job.company_id)
            .eq('sku_norm', norm)
            .limit(1)
          productId = match?.[0]?.id ?? null
        }
        rows.push({
          company_id: job.company_id,
          order_id: order.id,
          product_id: productId,
          sku: i.codigo,
          qty: i.quantidade,
          unit_price: i.valorUnitario,
          sold_on: soldOn,
          shadow: isShadow,
        })
      }
      const { error: itemErr } = await admin.from('sales_order_items').insert(rows)
      if (itemErr) throw new Error(`sales_order_items: ${itemErr.message}`)
    }

    await stampSalesSource(admin, job.company_id, client.provider)
    await admin.from('sync_jobs').update({ status: 'done' }).eq('id', job.id)
    return { done: true, processed: 1, error: null }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    if (await requeueIfRateLimited(admin, job, message)) {
      return { done: false, processed: 0, error: null }
    }
    await admin.from('sync_jobs').update({ status: 'error', last_error: message }).eq('id', job.id)
    return { done: false, processed: 0, error: message }
  } finally {
    await saveRateLimit(admin, job.connection_id, bucket.snapshot)
  }
}

// ---------------------------------------------------------------------------
// Ordens de compra (só v3) — o "em aberto" que o motor conta como trânsito.
// A cada rodada: lista as ordens em aberto/andamento no Tiny, rebusca cada
// uma (o aviso nunca é a verdade — mesmo princípio do webhook), grava
// pedido + itens, e reconcilia as locais que fecharam (atendida/cancelada
// sai do trânsito). O job se re-agenda sozinho a cada 30 min.
// ---------------------------------------------------------------------------

const PO_SITUACAO_STATUS: Record<number, string> = {
  0: 'open', 1: 'received', 2: 'cancelled', 3: 'open',
}

// deno-lint-ignore no-explicit-any
async function processPurchaseOrders(admin: any, job: any, client: TinyClient) {
  if (!client.listarOrdensCompra || !client.obterOrdemCompra) {
    const msg = 'ordens de compra exigem conexão v3 (a API v2 não tem o recurso)'
    await admin.from('sync_jobs').update({ status: 'error', last_error: msg }).eq('id', job.id)
    return { done: false, processed: 0, error: msg }
  }

  const bucket = new TokenBucket(await loadRateLimit(admin, job.connection_id))
  const call = makeSingleCall(bucket, client)
  let processed = 0

  try {
    // 1. O que está em aberto/andamento no Tiny agora.
    const abertas = new Set<string>()
    for (const situacao of [0, 3]) {
      let pagina = 1
      for (;;) {
        const page = await call(() => client.listarOrdensCompra!(situacao, pagina))
        for (const id of page.ids) abertas.add(id)
        if (pagina >= page.numeroPaginas) break
        pagina += 1
      }
    }

    // 2. + o que está aberto AQUI: ordem que fechou no Tiny some da listagem
    //    de abertas, mas precisa ser rebuscada para sair do trânsito.
    const { data: locais } = await admin
      .from('purchase_orders')
      .select('external_id')
      .eq('company_id', job.company_id)
      .eq('source', 'tiny_v3')
      .in('status', ['open', 'draft'])
    const alvo = new Set<string>(abertas)
    for (const po of locais ?? []) alvo.add(String(po.external_id))

    // 3. Rebusca e grava cada ordem — pedido + itens em substituição total.
    for (const externalId of alvo) {
      const oc = await call(() => client.obterOrdemCompra!(externalId))
      const status = PO_SITUACAO_STATUS[oc.situacao] ?? 'open'

      const { data: po, error: poErr } = await admin
        .from('purchase_orders')
        .upsert(
          {
            company_id: job.company_id,
            source: 'tiny_v3',
            external_id: oc.id,
            status,
            supplier: oc.fornecedor,
            ordered_on: oc.orderedOn || null,
            eta_on: oc.etaOn,
            note: oc.numero ? `OC ${oc.numero} (Tiny)` : 'Tiny',
          },
          { onConflict: 'company_id,source,external_id' },
        )
        .select('id')
        .single()
      if (poErr) throw new Error(`purchase_orders: ${poErr.message}`)

      const { error: delErr } = await admin
        .from('purchase_order_items').delete().eq('order_id', po.id)
      if (delErr) throw new Error(`purchase_order_items (limpeza): ${delErr.message}`)

      if (oc.itens.length > 0) {
        const { error: itemErr } = await admin.from('purchase_order_items').insert(
          oc.itens.map((i) => ({
            company_id: job.company_id,
            order_id: po.id,
            sku: i.sku,
            qty_ordered: i.quantidade,
            // Atendida = tudo recebido (qty_open zera); a v3 não expõe
            // recebimento parcial por item, então aberto/andamento conta
            // inteiro como trânsito — o mesmo que a planilha fazia.
            qty_received: status === 'received' ? i.quantidade : 0,
            eta_on: oc.etaOn,
          })),
        )
        if (itemErr) throw new Error(`purchase_order_items: ${itemErr.message}`)
      }
      processed += 1
    }

    // Carimbo da fonte: o trânsito agora tem dono e frescor visíveis na Saúde.
    const { count } = await admin
      .from('purchase_order_items')
      .select('*', { count: 'exact', head: true })
      .eq('company_id', job.company_id)
    await admin.from('data_sources').upsert({
      company_id: job.company_id,
      kind: 'in_transit',
      provider: 'tiny_v3',
      filename: null,
      row_count: count ?? 0,
      covers_until: new Date().toISOString().slice(0, 10),
      refreshed_at: new Date().toISOString(),
    }, { onConflict: 'company_id,kind' })

    // 4. Re-agenda a si mesmo — mesma mecânica do delta de pedidos.
    await admin.from('sync_jobs').update({
      status: 'queued',
      payload: { delta: true },
      run_after: new Date(Date.now() + 30 * 60 * 1000).toISOString(),
    }).eq('id', job.id)

    return { done: true, processed, error: null }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    if (await requeueIfRateLimited(admin, job, message)) {
      return { done: false, processed, error: null }
    }
    await admin.from('sync_jobs').update({ status: 'error', last_error: message }).eq('id', job.id)
    return { done: false, processed, error: message }
  } finally {
    await saveRateLimit(admin, job.connection_id, bucket.snapshot)
  }
}

/**
 * Auto-cura dos jobs recorrentes. Os deltas se re-agendam sozinhos, mas um
 * job que morre em `error` (ex.: apontando para uma conexão desconectada)
 * quebra a corrente para sempre — foi exatamente o que derrubou o delta de
 * pedidos da All Out na migração v2→v3. Aqui, a cada tick:
 *
 * - `purchase_orders` (só v3): renasce se morreu OU se nunca existiu —
 *   conexão v3 viva sempre tem um delta de OC na fila.
 * - `orders` delta (v2 e v3): SÓ renasce se já existiu um job `orders` antes
 *   (a corrente quebrou). Nunca nasce do zero aqui — o backfill inicial é
 *   decisão da tela de conexão, não do cron.
 *
 * Erro persistente não vira martelo: só renasce se o último job do tipo está
 * morto (done/error) há mais de 30 min — a fila viva o dedupe segura.
 * Insert simples ignorando 23505 (índice único parcial de dedupe).
 */
// deno-lint-ignore no-explicit-any
async function ensureRecurringJobs(admin: any) {
  const { data: conns } = await admin
    .from('integration_connections')
    .select('id, company_id, provider')
    .in('provider', ['tiny_v2', 'tiny_v3'])
    .eq('status', 'connected')
  for (const conn of conns ?? []) {
    const kinds: Array<{ kind: string; bornHere: boolean }> = [
      { kind: 'orders', bornHere: false },
    ]
    if (conn.provider === 'tiny_v3') kinds.push({ kind: 'purchase_orders', bornHere: true })

    for (const { kind, bornHere } of kinds) {
      const { data: last } = await admin
        .from('sync_jobs')
        .select('status, updated_at')
        .eq('company_id', conn.company_id)
        .eq('kind', kind)
        .order('updated_at', { ascending: false })
        .limit(1)
        .maybeSingle()
      if (!last && !bornHere) continue
      if (last && (['queued', 'running'].includes(last.status) ||
        Date.now() - new Date(last.updated_at).getTime() < 30 * 60 * 1000)) continue

      const { error } = await admin.from('sync_jobs').insert({
        company_id: conn.company_id,
        connection_id: conn.id,
        kind,
        payload: { delta: true },
        priority: 100,
        dedupe_key: `${conn.company_id}:${kind}:delta`,
      })
      if (error && error.code !== '23505') {
        console.error(`tiny-sync-worker: falha ao enfileirar ${kind} recorrente`, error.message)
      }
    }
  }
}

/**
 * Manutenção das conexões v3 (aplicativo OAuth): renova o access token quando
 * falta menos de ~35 min. O refresh token do Tiny vale só 1 dia — é ESTE cron
 * de minuto que mantém a conexão viva para sempre; renovar a cada ~3,5h fica
 * com folga enorme dentro da janela. Erro transitório (rede, 5xx) só loga e
 * tenta no próximo tick; `TinyV3AuthError` (refresh morto/revogado) marca a
 * conexão como error — reautorizar no navegador é a única saída, não adianta
 * martelar o Keycloak a cada minuto.
 */
// deno-lint-ignore no-explicit-any
async function maintainV3Tokens(admin: any, cryptoKey: CryptoKey) {
  const soon = new Date(Date.now() + 35 * 60_000).toISOString()
  const { data: conns } = await admin
    .from('integration_connections')
    .select('id, settings')
    .eq('provider', 'tiny_v3')
    .eq('status', 'connected')
    .lt('settings->>access_expires_at', soon)

  for (const conn of conns ?? []) {
    try {
      const { data: secretRow } = await admin
        .from('integration_secrets')
        .select('ciphertext, iv')
        .eq('connection_id', conn.id)
        .maybeSingle()
      if (!secretRow) continue
      const stored = JSON.parse(
        await decryptSecret(cryptoKey, secretRow.ciphertext, secretRow.iv),
      ) as TinyV3Secret
      await ensureFreshAccess(admin, cryptoKey, conn, stored, 35 * 60_000)
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      console.error('tiny-sync-worker: renovação v3 falhou', message)
      if (err instanceof TinyV3AuthError) {
        await admin.from('integration_connections').update({
          status: 'error', last_error: message,
        }).eq('id', conn.id)
      }
    }
  }
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: corsHeaders })

  const startedAt = Date.now()
  const supabaseUrl = Deno.env.get('SUPABASE_URL')!
  const serviceKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!
  const encRaw = Deno.env.get('TINY_ENCRYPTION_KEY')
  const syncSecret = Deno.env.get('TINY_SYNC_SECRET')
  if (!encRaw) return json({ error: 'TINY_ENCRYPTION_KEY não configurada' }, 500)

  const bearer = (req.headers.get('Authorization') ?? '').replace(/^Bearer\s+/i, '').trim()
  const isAllowed = (!!syncSecret && bearer === syncSecret) || bearer === serviceKey || !syncSecret
  if (!isAllowed) return json({ error: 'Unauthorized' }, 401)

  const admin = createClient(supabaseUrl, serviceKey)
  const cryptoKey = await deriveKey(encRaw)

  try {
    // Antes da fila: manter tokens v3 vivos independe de haver job — se a
    // fila passar horas ocupada OU horas vazia, a renovação acontece igual.
    await maintainV3Tokens(admin, cryptoKey)
    await ensureRecurringJobs(admin)

    const job = await admin.rpc('sync_jobs_claim').then((r) => r.data)
    // Fila vazia: o claim devolve a linha composta toda NULL (`returns
    // sync_jobs` sem match), que o PostgREST serializa como objeto de nulls —
    // truthy. Checar o id, não o objeto.
    if (!job?.id) return json({ ok: true, idle: true })

    const KINDS = ['products_stock', 'orders', 'stock_single', 'order_single', 'purchase_orders']
    if (!KINDS.includes(job.kind)) {
      // Um job de tipo desconhecido aqui seria bug de quem enfileirou —
      // falha alto e claro em vez de silenciosamente ignorar.
      await admin.from('sync_jobs').update({
        status: 'error', last_error: `kind desconhecido: ${job.kind}`,
      }).eq('id', job.id)
      return json({ error: `kind desconhecido: ${job.kind}` }, 500)
    }

    const { data: secret } = await admin
      .from('integration_secrets')
      .select('ciphertext, iv')
      .eq('connection_id', job.connection_id)
      .maybeSingle()
    if (!secret) {
      await admin.from('sync_jobs').update({ status: 'error', last_error: 'Token não encontrado' }).eq('id', job.id)
      return json({ error: 'Token não encontrado' }, 500)
    }
    const decrypted = await decryptSecret(cryptoKey, secret.ciphertext, secret.iv)

    // O provider decide o protocolo: v2 guarda o token puro como string; v3
    // guarda um JSON (client_secret + tokens OAuth) e precisa de access token
    // fresco ANTES do job — a manutenção do cron cobre o caso geral, mas um
    // job longo pode ser reclamado a qualquer momento.
    const { data: connRow } = await admin
      .from('integration_connections')
      .select('id, provider, settings')
      .eq('id', job.connection_id)
      .single()

    let client: TinyClient
    if (connRow?.provider === 'tiny_v3') {
      const stored = JSON.parse(decrypted) as TinyV3Secret
      try {
        const fresh = await ensureFreshAccess(admin, cryptoKey, connRow, stored)
        client = makeV3Client(fresh.access_token!)
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err)
        await admin.from('sync_jobs').update({ status: 'error', last_error: message }).eq('id', job.id)
        if (err instanceof TinyV3AuthError) {
          await admin.from('integration_connections').update({
            status: 'error', last_error: message,
          }).eq('id', job.connection_id)
        }
        return json({ error: message }, 502)
      }
    } else {
      client = makeV2Client(decrypted)
    }

    const result = job.kind === 'orders'
      ? await processOrders(admin, job, client, startedAt)
      : job.kind === 'order_single'
        ? await processOrderSingle(admin, job, client)
        : job.kind === 'stock_single'
          ? await processStockSingle(admin, job, client)
          : job.kind === 'purchase_orders'
            ? await processPurchaseOrders(admin, job, client)
            : await processProductsStock(admin, job, client, startedAt)
    return json({ ok: !result.error, ...result, elapsedMs: Date.now() - startedAt })
  } catch (err) {
    const message = err instanceof TinyTooManyRecordsError
      ? `Excesso de registros: ${err.message}`
      : (err instanceof Error ? err.message : String(err))
    console.error('tiny-sync-worker', message)
    return json({ error: message }, 502)
  }
})
