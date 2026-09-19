// ============================================================================
// tiny-connect — conectar/testar/desconectar a integração Olist (Tiny v2)
// ----------------------------------------------------------------------------
// Secrets:
//   SUPABASE_URL / SUPABASE_ANON_KEY / SUPABASE_SERVICE_ROLE_KEY (auto)
//   TINY_ENCRYPTION_KEY — 32 bytes em base64 (ou string >= 32 chars)
//
// Deploy:
//   supabase functions deploy tiny-connect
//   supabase secrets set TINY_ENCRYPTION_KEY="$(openssl rand -base64 32)"
//
// Ações (POST JSON, todas autenticadas):
//   { action: 'connect',    companyId, token, settings? }
//   { action: 'test',       companyId }
//   { action: 'disconnect', companyId }
//   { action: 'remove',     companyId, provider }   ← apaga a conexão
//   { action: 'settings',   companyId, settings }
//   { action: 'sync_now',   companyId }
//   { action: 'oauth_init',       companyId, clientId, clientSecret }  → authorizeUrl
//   { action: 'oauth_test',       companyId }
//   { action: 'oauth_disconnect', companyId }
// ----------------------------------------------------------------------------
// O token nunca fica em texto puro fora daqui: a UI manda o token uma vez,
// esta função valida contra o Tiny de verdade (uma chamada leve,
// `produtos.pesquisa` página 1) e só then criptografa e grava. Se a validação
// falha, nada é persistido — não existe "conexão com erro guardada com token
// errado esperando o worker descobrir".
// ============================================================================

import { createClient } from 'https://esm.sh/@supabase/supabase-js@2'
import { decryptSecret, deriveKey, encryptSecret } from '../_shared/crypto.ts'
import { TinyApiError, tinyTestConnection } from '../_shared/tiny.ts'
import {
  buildAuthorizeUrl,
  ensureFreshAccess,
  TinyV3AuthError,
  tinyV3Get,
  type TinyV3Secret,
} from '../_shared/tiny-v3.ts'

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
}

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, 'Content-Type': 'application/json' },
  })
}

/**
 * Enfileira com dedupe: insert simples ignorando 23505. Upsert com
 * `onConflict: 'dedupe_key'` não funciona aqui — o índice único de dedupe é
 * PARCIAL (`where status in ('queued','running')`) e o PostgREST não consegue
 * inferi-lo, então o upsert falharia com 42P10. Se já existe um job vivo com
 * a mesma chave, disparar de novo não empilha.
 */
// deno-lint-ignore no-explicit-any
async function enqueueJob(admin: any, row: Record<string, unknown>) {
  const { error } = await admin.from('sync_jobs').insert(row)
  if (error && error.code !== '23505') throw error
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: corsHeaders })

  try {
    const authHeader = req.headers.get('Authorization')
    if (!authHeader) return json({ error: 'Não autenticado' }, 401)

    const supabaseUrl = Deno.env.get('SUPABASE_URL')!
    const anonKey = Deno.env.get('SUPABASE_ANON_KEY')!
    const serviceKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!
    const encRaw = Deno.env.get('TINY_ENCRYPTION_KEY')
    if (!encRaw) return json({ error: 'Chave de criptografia não configurada' }, 500)

    const userClient = createClient(supabaseUrl, anonKey, {
      global: { headers: { Authorization: authHeader } },
    })
    const admin = createClient(supabaseUrl, serviceKey)

    const { data: { user }, error: userErr } = await userClient.auth.getUser()
    if (userErr || !user) return json({ error: 'Não autenticado' }, 401)

    const body = await req.json()
    const action = String(body.action ?? '')
    const companyId = String(body.companyId ?? '')
    if (!companyId) return json({ error: 'Informe a empresa' }, 400)

    // `has_company_role` só tem EXECUTE para `authenticated` (ver 0001) — por
    // isso a checagem passa pelo client do usuário, cujo JWT é quem dá a
    // `auth.uid()` que a função lê, e não pelo `admin` (service_role).
    const { data: canManage } = await userClient.rpc('has_company_role', {
      _company_id: companyId,
      _roles: ['owner', 'gestor'],
    })
    if (!canManage) return json({ error: 'Sem permissão nesta empresa' }, 403)

    const cryptoKey = await deriveKey(encRaw)

    if (action === 'connect') {
      const token = String(body.token ?? '').trim()
      if (!token) return json({ error: 'Informe o token do Tiny' }, 400)

      try {
        await tinyTestConnection({ token })
      } catch (err) {
        const message = err instanceof TinyApiError ? err.message : 'Não foi possível validar o token'
        return json({ error: message }, 400)
      }

      const { data: conn, error: connErr } = await admin
        .from('integration_connections')
        .upsert(
          {
            company_id: companyId,
            provider: 'tiny_v2',
            status: 'connected',
            last_error: null,
            settings: body.settings ?? {},
            connected_at: new Date().toISOString(),
          },
          { onConflict: 'company_id,provider' },
        )
        .select('id')
        .single()
      if (connErr) throw connErr

      const enc = await encryptSecret(cryptoKey, token)
      const { error: secErr } = await admin.from('integration_secrets').upsert({
        connection_id: conn.id,
        ciphertext: enc.ciphertext,
        iv: enc.iv,
        key_version: enc.key_version,
        updated_at: new Date().toISOString(),
      })
      if (secErr) throw secErr

      // Primeiro sync entra na fila na hora — sem isso a tela mostraria
      // "conectado" com zero produto até o próximo cron, o que parece quebrado.
      await enqueueJob(admin, {
        company_id: companyId,
        connection_id: conn.id,
        kind: 'products_stock',
        dedupe_key: `${companyId}:products_stock`,
        priority: 200,
      })
      // Backfill de vendas (12 meses, modo shadow). Prioridade menor: produto
      // e estoque primeiro — é o mapa de SKUs que casa os itens de venda.
      await enqueueJob(admin, {
        company_id: companyId,
        connection_id: conn.id,
        kind: 'orders',
        dedupe_key: `${companyId}:orders:backfill`,
        priority: 100,
      })

      return json({ ok: true, connectionId: conn.id })
    }

    // ------------------------------------------------------------------
    // API v3 (aplicativo OAuth). Conexão separada (`provider = 'tiny_v3'`)
    // ao lado da v2 — a v2 continua sendo quem sincroniza até a migração.
    // ------------------------------------------------------------------

    if (action === 'oauth_init') {
      const clientId = String(body.clientId ?? '').trim()
      const clientSecret = String(body.clientSecret ?? '').trim()
      if (!clientId || !clientSecret) {
        return json({ error: 'Informe o client_id e o client_secret do aplicativo' }, 400)
      }

      // Para onde voltar depois do consentimento: a origem da própria UI que
      // chamou. Só o navegador do dono da sessão chega aqui (JWT validado
      // acima), então o Origin é confiável o bastante para um redirect.
      const origin = req.headers.get('Origin') ?? ''
      if (!/^https?:\/\//.test(origin)) return json({ error: 'Origem da requisição inválida' }, 400)

      const state = crypto.randomUUID()
      const { data: conn, error: connErr } = await admin
        .from('integration_connections')
        .upsert(
          {
            company_id: companyId,
            provider: 'tiny_v3',
            status: 'disconnected',
            last_error: null,
            settings: { client_id: clientId, oauth_state: state, return_to: origin },
          },
          { onConflict: 'company_id,provider' },
        )
        .select('id')
        .single()
      if (connErr) throw connErr

      const secret: TinyV3Secret = {
        client_secret: clientSecret,
        access_token: null,
        refresh_token: null,
        access_expires_at: null,
        refresh_expires_at: null,
      }
      const enc = await encryptSecret(cryptoKey, JSON.stringify(secret))
      const { error: secErr } = await admin.from('integration_secrets').upsert({
        connection_id: conn.id,
        ciphertext: enc.ciphertext,
        iv: enc.iv,
        key_version: enc.key_version,
        updated_at: new Date().toISOString(),
      })
      if (secErr) throw secErr

      const redirectUri = `${supabaseUrl}/functions/v1/tiny-oauth/callback`
      return json({ ok: true, authorizeUrl: buildAuthorizeUrl(clientId, redirectUri, state) })
    }

    if (action === 'oauth_test' || action === 'oauth_disconnect') {
      const { data: v3conn } = await admin
        .from('integration_connections')
        .select('id, status, settings')
        .eq('company_id', companyId)
        .eq('provider', 'tiny_v3')
        .maybeSingle()
      if (!v3conn) return json({ error: 'Nenhuma conexão v3 configurada' }, 404)

      if (action === 'oauth_disconnect') {
        await admin.from('integration_connections').update({
          status: 'disconnected', last_error: null,
        }).eq('id', v3conn.id)
        await admin.from('integration_secrets').delete().eq('connection_id', v3conn.id)
        return json({ ok: true })
      }

      const { data: secretRow } = await admin
        .from('integration_secrets')
        .select('ciphertext, iv')
        .eq('connection_id', v3conn.id)
        .maybeSingle()
      if (!secretRow) return json({ error: 'Credenciais não encontradas — conecte de novo' }, 404)

      try {
        const stored = JSON.parse(
          await decryptSecret(cryptoKey, secretRow.ciphertext, secretRow.iv),
        ) as TinyV3Secret
        const fresh = await ensureFreshAccess(admin, cryptoKey, v3conn, stored)
        await tinyV3Get(fresh.access_token!, '/produtos', { limit: '1' })
      } catch (err) {
        const message = err instanceof TinyV3AuthError || err instanceof Error
          ? err.message
          : 'Falha ao testar'
        await admin.from('integration_connections').update({
          status: 'error', last_error: message,
        }).eq('id', v3conn.id)
        return json({ error: message }, 400)
      }

      await admin.from('integration_connections').update({
        status: 'connected', last_error: null,
      }).eq('id', v3conn.id)
      return json({ ok: true })
    }

    // Apagar é diferente de desconectar: `disconnect` deixa a linha lá, com
    // status `disconnected`, e a integração continua listada na tela esperando
    // um "Reconectar". `remove` tira a integração da empresa — e as chaves
    // estrangeiras de 0009 fazem o resto cair junto em cascata (segredo, fila,
    // execuções, eventos de webhook). Produto, estoque e venda ficam: eles
    // apontam para a empresa, não para a conexão, e jogar fora o histórico
    // porque alguém trocou de ERP seria a decisão errada tomada por engano.
    if (action === 'remove') {
      const provider = String(body.provider ?? 'tiny_v2')
      if (provider !== 'tiny_v2' && provider !== 'tiny_v3') {
        return json({ error: 'Provedor inválido' }, 400)
      }
      const { error } = await admin
        .from('integration_connections')
        .delete()
        .eq('company_id', companyId)
        .eq('provider', provider)
      if (error) throw error
      return json({ ok: true })
    }

    const { data: conn } = await admin
      .from('integration_connections')
      .select('id, status')
      .eq('company_id', companyId)
      .eq('provider', 'tiny_v2')
      .maybeSingle()

    if (action === 'test') {
      if (!conn) return json({ error: 'Nenhuma conexão configurada' }, 404)
      const { data: secret } = await admin
        .from('integration_secrets')
        .select('ciphertext, iv')
        .eq('connection_id', conn.id)
        .maybeSingle()
      if (!secret) return json({ error: 'Token não encontrado' }, 404)

      const token = await decryptSecret(cryptoKey, secret.ciphertext, secret.iv)
      try {
        await tinyTestConnection({ token })
      } catch (err) {
        const message = err instanceof TinyApiError ? err.message : 'Falha ao testar'
        await admin.from('integration_connections').update({ status: 'error', last_error: message }).eq('id', conn.id)
        return json({ error: message }, 400)
      }
      await admin.from('integration_connections').update({ status: 'connected', last_error: null }).eq('id', conn.id)
      return json({ ok: true })
    }

    if (action === 'disconnect') {
      if (!conn) return json({ ok: true })
      await admin.from('integration_connections').update({
        status: 'disconnected', last_error: null,
      }).eq('id', conn.id)
      await admin.from('integration_secrets').delete().eq('connection_id', conn.id)
      return json({ ok: true })
    }

    if (action === 'settings') {
      if (!conn) return json({ error: 'Nenhuma conexão configurada' }, 404)
      await admin.from('integration_connections').update({ settings: body.settings ?? {} }).eq('id', conn.id)
      return json({ ok: true })
    }

    if (action === 'sync_now') {
      if (!conn || conn.status !== 'connected') return json({ error: 'Conecte o Tiny antes de sincronizar' }, 400)
      await enqueueJob(admin, {
        company_id: companyId,
        connection_id: conn.id,
        kind: 'products_stock',
        dedupe_key: `${companyId}:products_stock`,
        priority: 200,
      })
      // Recobre os últimos 7 dias de vendas (shadow) junto com o estoque. Se o
      // delta recorrente já está na fila (dedupe segura o insert), antecipa o
      // `run_after` dele — senão "sincronizar agora" só rodaria dali a 30 min.
      await enqueueJob(admin, {
        company_id: companyId,
        connection_id: conn.id,
        kind: 'orders',
        payload: { delta: true },
        dedupe_key: `${companyId}:orders:delta`,
        priority: 150,
      })
      await admin.from('sync_jobs')
        .update({ run_after: new Date().toISOString() })
        .eq('dedupe_key', `${companyId}:orders:delta`)
        .eq('status', 'queued')
      return json({ ok: true })
    }

    return json({ error: 'Ação inválida' }, 400)
  } catch (err) {
    console.error('tiny-connect', err)
    return json({ error: err instanceof Error ? err.message : 'Erro interno' }, 500)
  }
})
