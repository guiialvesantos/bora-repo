// ============================================================================
// tiny-webhook — recebe eventos do Tiny e só enfileira
// ----------------------------------------------------------------------------
// Deploy:
//   supabase functions deploy tiny-webhook --no-verify-jwt
//
// URL cadastrada no Tiny: /functions/v1/tiny-webhook/<webhook_token>
// O token vem no PATH, não em header — é assim que o Tiny manda.
//
// ----------------------------------------------------------------------------
// Regra única desta função: NUNCA calcular aqui dentro. Só grava a linha em
// `integration_webhook_events` e enfileira um `sync_jobs` (`stock_single` /
// `order_single`, processados pelo tiny-sync-worker). O Tiny retenta
// entrega até 10 vezes quando não recebe 200 rápido — se o handler computasse
// no meio da requisição, uma trava de banco lenta viraria dez execuções
// concorrentes do mesmo evento. Gravar e devolver 200 é sempre rápido, e um
// evento gravado duas vezes vira só um job (dedupe_key), então processar duas
// vezes é gravar o mesmo resultado duas vezes — inofensivo.
// ============================================================================

import { createClient } from 'https://esm.sh/@supabase/supabase-js@2'

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } })
}

Deno.serve(async (req) => {
  if (req.method !== 'POST') return json({ error: 'Method not allowed' }, 405)

  const url = new URL(req.url)
  const token = url.pathname.split('/').filter(Boolean).pop()
  if (!token) return json({ error: 'Token ausente na URL' }, 400)

  const supabaseUrl = Deno.env.get('SUPABASE_URL')!
  const serviceKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!
  const admin = createClient(supabaseUrl, serviceKey)

  const { data: tokenConn } = await admin
    .from('integration_connections')
    .select('id, company_id, status')
    .eq('webhook_token', token)
    .maybeSingle()
  // 200 mesmo em token desconhecido: dar 4xx só ensina o Tiny a retentar um
  // evento que nunca vai encontrar dono.
  if (!tokenConn) return json({ ok: true, ignored: true })

  // O painel do Tiny pode continuar registrado com a URL de uma conexão
  // antiga (ex.: a v2 desconectada depois da migração para v3). O token
  // identifica a EMPRESA; o job tem que ir para a conexão viva dela — senão
  // o worker fica preso num "Token não encontrado" a cada evento novo.
  let conn = tokenConn
  if (tokenConn.status !== 'connected') {
    const { data: alive } = await admin
      .from('integration_connections')
      .select('id, company_id, status')
      .eq('company_id', tokenConn.company_id)
      .eq('status', 'connected')
      .like('provider', 'tiny%')
      .maybeSingle()
    if (!alive) return json({ ok: true, ignored: true })
    conn = alive
  }

  let payload: unknown = {}
  try {
    payload = await req.json()
  } catch {
    payload = {}
  }
  const eventType = (payload as { tipo?: string })?.tipo ?? null

  await admin.from('integration_webhook_events').insert({
    company_id: conn.company_id,
    connection_id: conn.id,
    event_type: eventType,
    payload,
  })

  // Classificação do evento → micro-job. O corpo do aviso NUNCA é a verdade:
  // daqui sai só o id, e o worker rebusca tudo na API (`produto.obter.estoque`
  // / `pedido.obter`). Substring em `tipo` porque o Tiny varia o nome do aviso
  // ("estoque", "atualizacao_estoque", "inclusao_pedido", "atualizacao_pedido"…)
  // — e o evento cru já ficou gravado acima para auditar formato novo.
  // deno-lint-ignore no-explicit-any
  const dados = (payload as any)?.dados ?? {}
  const tipo = String(eventType ?? '').toLowerCase()
  let kind: 'stock_single' | 'order_single' | null = null
  let refId: unknown = null
  if (tipo.includes('pedido') || tipo.includes('venda')) {
    refId = dados.idPedido ?? dados.idVendaTiny ?? dados.id ?? null
    if (refId != null) kind = 'order_single'
  } else if (tipo.includes('estoque') || tipo.includes('produto')) {
    refId = dados.idProduto ?? dados.id ?? null
    if (refId != null) kind = 'stock_single'
  }

  if (kind && refId != null) {
    const payloadKey = kind === 'order_single' ? 'tinyOrderId' : 'tinyProductId'
    // Prioridade acima do delta/backfill (100): evento de agora fura a fila.
    // Rajada do mesmo produto/pedido colapsa num job só (dedupe entre jobs
    // vivos) — 23505 aqui é "já tem um na fila", não erro.
    const { error: jobErr } = await admin.from('sync_jobs').insert({
      company_id: conn.company_id,
      connection_id: conn.id,
      kind,
      payload: { [payloadKey]: String(refId) },
      priority: 200,
      dedupe_key: `${conn.company_id}:${kind}:${refId}`,
    })
    if (jobErr && jobErr.code !== '23505') {
      console.error('tiny-webhook: falha ao enfileirar job', jobErr.message)
    }
  }

  return json({ ok: true })
})
