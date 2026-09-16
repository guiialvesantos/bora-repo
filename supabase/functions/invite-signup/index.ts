// ============================================================================
// invite-signup — cria a conta de quem recebeu um convite
// ----------------------------------------------------------------------------
// Deploy:
//   supabase functions deploy invite-signup --no-verify-jwt
//
// POST { token, password, fullName? } → { email }
//
// ----------------------------------------------------------------------------
// Por que isto existe, em vez de um `signUp()` direto do navegador:
//
// O projeto está com `mailer_autoconfirm = false`, então `signUp()` devolve um
// usuário SEM sessão e fica esperando a pessoa clicar no link de confirmação
// que sai pelo SMTP embutido do Supabase — que é limitado a poucos e-mails por
// hora e, em projeto novo, só entrega para os endereços da própria equipe. O
// convite morreria na caixa de entrada de ninguém.
//
// Aqui o e-mail já está verificado por construção: quem tem o token recebeu o
// link no endereço que o dono digitou. O token é a prova. Por isso o usuário
// nasce com `email_confirm: true` e o e-mail vem do convite, não do corpo da
// requisição — quem chama escolhe a senha, nunca a identidade.
//
// A função é pública (`--no-verify-jwt`) porque quem a chama ainda não tem
// conta. O que a protege é o token de 24 bytes, que existe só como hash no
// banco; e ela não revela nada sobre convites inválidos além de "inválido".
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

async function sha256Hex(input: string): Promise<string> {
  const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(input))
  return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, '0')).join('')
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: corsHeaders })
  if (req.method !== 'POST') return json({ error: 'Método não suportado' }, 405)

  try {
    const admin = createClient(
      Deno.env.get('SUPABASE_URL')!,
      Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!,
    )

    const body = await req.json().catch(() => ({}))
    const token = String(body.token ?? '')
    const password = String(body.password ?? '')
    const fullName = String(body.fullName ?? '').trim()

    if (password.length < 8) {
      return json({ error: 'A senha precisa ter pelo menos 8 caracteres' }, 400)
    }

    const { data: invite } = await admin
      .from('company_invitations')
      .select('email, expires_at, accepted_at')
      .eq('token_hash', await sha256Hex(token))
      .maybeSingle()

    if (!invite || invite.accepted_at || new Date(invite.expires_at) <= new Date()) {
      return json({ error: 'Convite inválido, expirado ou já usado' }, 400)
    }

    const { error } = await admin.auth.admin.createUser({
      email: invite.email,
      password,
      email_confirm: true,
      user_metadata: fullName ? { full_name: fullName } : {},
    })

    if (error) {
      // Já ter conta não é erro do usuário — é o caminho "entrar" em vez de
      // "criar". A tela precisa distinguir isso para não pedir uma senha nova
      // a quem já tem uma.
      const exists = /already/i.test(error.message) || /registered/i.test(error.message)
      return json(
        { error: exists ? 'Já existe conta com este e-mail' : error.message, code: exists ? 'user_exists' : undefined },
        exists ? 409 : 400,
      )
    }

    // O e-mail volta porque a tela precisa dele para o `signInWithPassword`
    // logo em seguida: quem está criando a conta nunca digitou o endereço.
    return json({ email: invite.email })
  } catch (e) {
    return json({ error: e instanceof Error ? e.message : 'Erro inesperado' }, 500)
  }
})
