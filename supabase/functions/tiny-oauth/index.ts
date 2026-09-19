// ============================================================================
// tiny-oauth — callback do OAuth 2 do aplicativo Tiny (API v3)
// ----------------------------------------------------------------------------
// Deploy: verify_jwt = false — quem chama é o NAVEGADOR do usuário voltando do
// accounts.tiny.com.br, sem nenhum header nosso. A autorização real está no
// `state`: valor aleatório gerado pelo `tiny-connect` (action oauth_init) e
// guardado em `settings.oauth_state` da conexão. Sem state casado, nada
// acontece — um code roubado não se troca sozinho porque a troca também exige
// o client_secret, que só existe criptografado no banco.
//
// GET /tiny-oauth/callback?code=...&state=...
//   1. acha a conexão tiny_v3 pelo state (single-use: é apagado ao consumir)
//   2. troca o code por access+refresh token (client_secret descriptografado)
//   3. regrava o segredo com os tokens e marca a conexão como connected
//   4. 302 de volta para /integracoes do app (origem salva no oauth_init)
//
// Nunca devolve HTML com o token nem loga segredo — em erro, redireciona com
// ?tiny_v3=error e grava o motivo em last_error para a UI mostrar.
// ============================================================================

import { createClient } from 'https://esm.sh/@supabase/supabase-js@2'
import { decryptSecret, deriveKey, encryptSecret } from '../_shared/crypto.ts'
import {
  exchangeCode,
  TinyV3AuthError,
  tokensToSecretFields,
  type TinyV3Secret,
} from '../_shared/tiny-v3.ts'

function redirect(to: string) {
  return new Response(null, { status: 302, headers: { Location: to } })
}

Deno.serve(async (req) => {
  const url = new URL(req.url)
  if (!url.pathname.endsWith('/callback')) {
    return new Response(JSON.stringify({ error: 'Rota desconhecida' }), { status: 404 })
  }

  const supabaseUrl = Deno.env.get('SUPABASE_URL')!
  const serviceKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!
  const encRaw = Deno.env.get('TINY_ENCRYPTION_KEY')
  if (!encRaw) return new Response('Chave de criptografia não configurada', { status: 500 })
  const admin = createClient(supabaseUrl, serviceKey)

  const state = url.searchParams.get('state') ?? ''
  const code = url.searchParams.get('code') ?? ''

  // Sem state válido não há para onde redirecionar (o return_to mora na
  // conexão que o state identifica) — resposta seca, sem vazar nada.
  if (!state || !code) return new Response('Requisição inválida', { status: 400 })

  const { data: conn } = await admin
    .from('integration_connections')
    .select('id, company_id, settings')
    .eq('provider', 'tiny_v3')
    .eq('settings->>oauth_state', state)
    .maybeSingle()
  if (!conn) return new Response('Autorização não reconhecida — reinicie a conexão no BoraRepô', { status: 400 })

  const settings = (conn.settings ?? {}) as Record<string, unknown>
  const returnTo = typeof settings.return_to === 'string' && settings.return_to
    ? `${settings.return_to}/integracoes`
    : null
  const fail = async (reason: string) => {
    await admin.from('integration_connections').update({
      status: 'error',
      last_error: reason,
      settings: { ...settings, oauth_state: null },
    }).eq('id', conn.id)
    return returnTo
      ? redirect(`${returnTo}?tiny_v3=error`)
      : new Response(reason, { status: 400 })
  }

  try {
    const cryptoKey = await deriveKey(encRaw)
    const { data: secretRow } = await admin
      .from('integration_secrets')
      .select('ciphertext, iv')
      .eq('connection_id', conn.id)
      .maybeSingle()
    if (!secretRow) return await fail('Credenciais do aplicativo não encontradas — conecte de novo')

    const secret = JSON.parse(
      await decryptSecret(cryptoKey, secretRow.ciphertext, secretRow.iv),
    ) as TinyV3Secret
    const clientId = String(settings.client_id ?? '')
    if (!clientId || !secret.client_secret) {
      return await fail('client_id/client_secret ausentes — refaça a conexão')
    }

    const tokens = tokensToSecretFields(await exchangeCode({
      clientId,
      clientSecret: secret.client_secret,
      code,
      redirectUri: `${supabaseUrl}/functions/v1/tiny-oauth/callback`,
    }))

    const enc = await encryptSecret(cryptoKey, JSON.stringify({
      client_secret: secret.client_secret,
      ...tokens,
    } satisfies TinyV3Secret))
    const { error: secErr } = await admin.from('integration_secrets').upsert({
      connection_id: conn.id,
      ciphertext: enc.ciphertext,
      iv: enc.iv,
      key_version: enc.key_version,
      updated_at: new Date().toISOString(),
    })
    if (secErr) throw secErr

    // Expirações em claro nos settings: o worker decide "precisa renovar?"
    // com um WHERE simples, sem descriptografar segredo de ninguém.
    const { error: connErr } = await admin.from('integration_connections').update({
      status: 'connected',
      last_error: null,
      connected_at: new Date().toISOString(),
      settings: {
        ...settings,
        oauth_state: null,
        access_expires_at: tokens.access_expires_at,
        refresh_expires_at: tokens.refresh_expires_at,
      },
    }).eq('id', conn.id)
    if (connErr) throw connErr

    // Conexão viva → o sync começa sozinho: produtos+estoque primeiro
    // (prioridade maior) e o backfill de pedidos atrás. Insert simples
    // tolerando 23505: o índice único de dedupe é PARCIAL (só jobs vivos) e
    // upsert com onConflict falharia com 42P10.
    const initialJobs = [
      {
        company_id: conn.company_id,
        connection_id: conn.id,
        kind: 'products_stock',
        payload: {},
        priority: 200,
        dedupe_key: `${conn.company_id}:products_stock`,
      },
      {
        company_id: conn.company_id,
        connection_id: conn.id,
        kind: 'orders',
        payload: {},
        priority: 100,
        dedupe_key: `${conn.company_id}:orders:backfill`,
      },
    ]
    for (const jobRow of initialJobs) {
      const { error: jobErr } = await admin.from('sync_jobs').insert(jobRow)
      if (jobErr && jobErr.code !== '23505') {
        console.error('tiny-oauth: falha ao enfileirar job inicial', jobErr.message)
      }
    }

    return returnTo ? redirect(`${returnTo}?tiny_v3=connected`) : new Response('Conectado. Volte ao BoraRepô.')
  } catch (err) {
    console.error('tiny-oauth', err)
    const reason = err instanceof TinyV3AuthError ? err.message : 'Falha ao concluir a autorização'
    return await fail(reason)
  }
})
