// ============================================================================
// trier-connect — emitir e revogar chaves de conector da Trier Sistemas
// ----------------------------------------------------------------------------
// Secrets: SUPABASE_URL / SUPABASE_ANON_KEY / SUPABASE_SERVICE_ROLE_KEY (auto)
//
// Deploy:
//   supabase functions deploy trier-connect
//
// Ações (POST JSON, autenticadas, owner ou gestor da empresa):
//   { action: 'issue',      companyId, label }  → { key }  (mostrada UMA vez)
//   { action: 'revoke',     companyId, connectorId }
//   { action: 'disconnect', companyId }
//   { action: 'remove',     companyId }             ← apaga a conexão
//
// ----------------------------------------------------------------------------
// Diferença essencial para o `tiny-connect`: aqui NÃO existe token de terceiro
// para guardar. O token da Trier fica no arquivo de configuração do conector,
// dentro da farmácia, ao lado do servidor SGF — nunca chega neste servidor.
// O que esta função emite é uma credencial NOSSA, que só sabe escrever dados
// desta empresa e que o cliente pode revogar sozinho quando trocar o
// computador da loja ou demitir o técnico que instalou.
//
// A chave é gerada, mostrada uma vez e guardada só como sha256. Não há "ver a
// chave de novo" — perdeu, emite outra e revoga a anterior. É a mesma postura
// de `integration_secrets`, levada ao limite: nem criptografada em repouso ela
// fica, porque ninguém precisa lê-la de volta.
// ============================================================================

import { createClient } from 'https://esm.sh/@supabase/supabase-js@2'

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

async function sha256Hex(value: string) {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value))
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('')
}

/**
 * 32 bytes aleatórios em base64url, com prefixo legível. O prefixo serve para
 * quem encontrar a string solta num e-mail ou num print saber o que ela é e de
 * quem cobrar — segredo sem procedência é segredo que ninguém revoga.
 */
function generateKey() {
  const bytes = crypto.getRandomValues(new Uint8Array(32))
  const b64 = btoa(String.fromCharCode(...bytes))
    .replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
  return `brtr_${b64}`
}

const slug = (name: string) =>
  name.trim().toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '') || 'loja'

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: corsHeaders })

  try {
    const authHeader = req.headers.get('Authorization')
    if (!authHeader) return json({ error: 'Não autenticado' }, 401)

    const supabaseUrl = Deno.env.get('SUPABASE_URL')!
    const anonKey = Deno.env.get('SUPABASE_ANON_KEY')!
    const serviceKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!

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

    // Mesma checagem do `tiny-connect`: `has_company_role` só tem EXECUTE para
    // `authenticated`, então passa pelo client do usuário — é o JWT dele que dá
    // a `auth.uid()` que a função lê.
    const { data: canManage } = await userClient.rpc('has_company_role', {
      _company_id: companyId,
      _roles: ['owner', 'gestor'],
    })
    if (!canManage) return json({ error: 'Sem permissão nesta empresa' }, 403)

    if (action === 'issue') {
      const label = String(body.label ?? '').trim()
      if (!label) return json({ error: 'Dê um nome à loja (ex.: "Farmácia Centro")' }, 400)

      // Um depósito por loja. Se já existe um com o mesmo `external_id`, o
      // upsert reaproveita — reemitir a chave de uma loja não cria depósito
      // duplicado nem perde o histórico de estoque dela.
      const { data: warehouse, error: whErr } = await admin
        .from('warehouses')
        .upsert(
          { company_id: companyId, external_id: `trier-loja-${slug(label)}`, name: label },
          { onConflict: 'company_id,external_id' },
        )
        .select('id')
        .single()
      if (whErr) throw whErr

      const { data: conn, error: connErr } = await admin
        .from('integration_connections')
        .upsert(
          {
            company_id: companyId,
            provider: 'trier_sgf',
            // Nasce desconectada: quem declara a conexão viva é o conector, no
            // primeiro lote que chega de verdade. Mostrar "conectado" só porque
            // uma chave foi gerada seria mentir para quem ainda nem instalou.
            status: 'disconnected',
            last_error: null,
          },
          { onConflict: 'company_id,provider' },
        )
        .select('id')
        .single()
      if (connErr) throw connErr

      const key = generateKey()
      const { data: connector, error: ctErr } = await admin
        .from('trier_connectors')
        .insert({
          company_id: companyId,
          connection_id: conn.id,
          label,
          warehouse_id: warehouse.id,
          key_prefix: key.slice(0, 13),
          key_hash: await sha256Hex(key),
        })
        .select('id, label, key_prefix')
        .single()
      if (ctErr) throw ctErr

      // Única vez que a chave existe em texto fora da farmácia.
      return json({ ok: true, key, connector })
    }

    if (action === 'revoke') {
      const connectorId = String(body.connectorId ?? '')
      if (!connectorId) return json({ error: 'Informe o conector' }, 400)
      const { error } = await admin
        .from('trier_connectors')
        .update({ revoked_at: new Date().toISOString() })
        .eq('id', connectorId)
        .eq('company_id', companyId)
      if (error) throw error
      return json({ ok: true })
    }

    if (action === 'disconnect') {
      const { data: conn } = await admin
        .from('integration_connections')
        .select('id')
        .eq('company_id', companyId)
        .eq('provider', 'trier_sgf')
        .maybeSingle()
      if (!conn) return json({ ok: true })

      // Desconectar revoga TODAS as chaves. Deixar uma viva depois de o cliente
      // pedir para desligar seria manter uma porta aberta que a tela diz estar
      // fechada.
      await admin
        .from('trier_connectors')
        .update({ revoked_at: new Date().toISOString() })
        .eq('connection_id', conn.id)
        .is('revoked_at', null)
      await admin
        .from('integration_connections')
        .update({ status: 'disconnected', last_error: null })
        .eq('id', conn.id)
      return json({ ok: true })
    }

    // Apagar a integração inteira. Os conectores caem em cascata (0038), então
    // nenhuma chave sobra viva. O depósito de cada loja FICA — `warehouse_id` é
    // `on delete restrict` de propósito: o estoque daquela farmácia continua
    // contado no motor, e quem quiser tirá-lo desliga o depósito na aba
    // Depósitos, que é onde essa decisão mora.
    if (action === 'remove') {
      const { error } = await admin
        .from('integration_connections')
        .delete()
        .eq('company_id', companyId)
        .eq('provider', 'trier_sgf')
      if (error) throw error
      return json({ ok: true })
    }

    return json({ error: 'Ação inválida' }, 400)
  } catch (err) {
    console.error('trier-connect', err)
    return json({ error: err instanceof Error ? err.message : 'Erro interno' }, 500)
  }
})
