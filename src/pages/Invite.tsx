import { useState } from 'react'
import { useNavigate, useParams } from 'react-router-dom'
import { toast } from 'sonner'
import { Loader2 } from 'lucide-react'
import { supabase } from '@/lib/supabase'
import { useAuth } from '@/contexts/AuthContext'
import { useCompany } from '@/contexts/CompanyContext'
import { LogoLoader } from '@/components/brand/Logo'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'

/**
 * A tela do convite.
 *
 * Ela não sabe de quem é o convite enquanto ninguém estiver logado — e isso é
 * de propósito. Ler o convite sem sessão exigiria uma função executável por
 * `anon`, que é exatamente o que `scripts/audit-grants.mjs` quebra o build
 * para impedir. Então a ordem é: prove quem você é, aí a gente diz para onde
 * você foi convidado.
 *
 * Quem não tem conta cria aqui mesmo, e a conta nasce com o e-mail já
 * confirmado (ver a Edge Function `invite-signup`): o token do convite chegou
 * no endereço que o dono digitou, então o endereço já está provado. Mandar um
 * segundo e-mail de confirmação seria pedir de novo uma prova que já temos —
 * e o SMTP embutido do Supabase provavelmente não entregaria.
 */
export default function Invite() {
  const { token = '' } = useParams()
  const navigate = useNavigate()
  const { session, loading } = useAuth()
  const { refetch, selectCompany } = useCompany()

  const [mode, setMode] = useState<'signup' | 'signin'>('signup')
  const [email, setEmail] = useState('')
  const [fullName, setFullName] = useState('')
  const [password, setPassword] = useState('')
  const [busy, setBusy] = useState(false)

  async function accept() {
    setBusy(true)
    const { data, error } = await supabase.rpc('invitation_accept', { _token: token })
    setBusy(false)
    if (error) return toast.error(error.message)

    await refetch()
    selectCompany(data as string)
    toast.success('Convite aceito')
    navigate('/painel', { replace: true })
  }

  async function signUp(e: React.FormEvent) {
    e.preventDefault()
    setBusy(true)
    try {
      const res = await fetch(
        `${import.meta.env.VITE_SUPABASE_URL}/functions/v1/invite-signup`,
        {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            apikey: import.meta.env.VITE_SUPABASE_ANON_KEY as string,
          },
          body: JSON.stringify({ token, password, fullName }),
        },
      )
      const body = await res.json()

      if (!res.ok) {
        if (body.code === 'user_exists') {
          setMode('signin')
          toast.info('Você já tem conta. Entre com sua senha para aceitar o convite.')
          return
        }
        toast.error(body.error ?? 'Não foi possível criar a conta')
        return
      }

      // O e-mail vem da resposta porque quem está criando a conta nunca o
      // digitou: ele está no convite, não no formulário.
      const { error } = await supabase.auth.signInWithPassword({ email: body.email, password })
      if (error) toast.error(error.message)
    } finally {
      setBusy(false)
    }
  }

  async function signIn(e: React.FormEvent) {
    e.preventDefault()
    setBusy(true)
    const { error } = await supabase.auth.signInWithPassword({ email, password })
    setBusy(false)
    if (error) toast.error(error.message)
  }

  // Era `return null`: tela branca até a sessão responder. Numa página aberta
  // por link de convite esse é o pior lugar possível para não mostrar nada —
  // quem chega aqui não conhece o sistema e não tem como distinguir demora de
  // carregamento de link quebrado.
  if (loading) {
    return (
      <div className="flex min-h-screen items-center justify-center bg-background p-6">
        <LogoLoader className="w-[76px] text-brand-600" />
      </div>
    )
  }

  return (
    <div className="flex min-h-screen items-center justify-center bg-background p-6">
      <Card className="w-full max-w-sm">
        <CardHeader>
          <CardTitle className="font-display text-xl">Convite · BoraRepô</CardTitle>
          <CardDescription>
            {session
              ? `Você está entrando como ${session.user.email}.`
              : 'Entre ou crie sua conta para aceitar o convite.'}
          </CardDescription>
        </CardHeader>

        <CardContent>
          {session ? (
            <div className="space-y-3">
              <Button className="w-full" onClick={accept} disabled={busy}>
                {busy && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
                Aceitar convite
              </Button>
              {/* Convite é para um e-mail específico. Quem já estava logado com
                  outra conta precisa de uma saída — sem isto, o erro "este
                  convite é para outro e-mail" não tem o que fazer a seguir. */}
              <Button
                variant="ghost"
                className="w-full"
                onClick={async () => { await supabase.auth.signOut() }}
              >
                Não sou eu — sair
              </Button>
            </div>
          ) : mode === 'signup' ? (
            <form onSubmit={signUp} className="space-y-4">
              <div className="space-y-1.5">
                <Label htmlFor="name">Seu nome</Label>
                <Input id="name" value={fullName} onChange={(e) => setFullName(e.target.value)} />
              </div>
              <div className="space-y-1.5">
                <Label htmlFor="password">Crie uma senha</Label>
                <Input
                  id="password"
                  type="password"
                  autoComplete="new-password"
                  required
                  minLength={8}
                  value={password}
                  onChange={(e) => setPassword(e.target.value)}
                />
                <p className="text-xs text-muted-foreground">Mínimo de 8 caracteres.</p>
              </div>
              <Button type="submit" className="w-full" disabled={busy}>
                {busy && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
                Criar conta
              </Button>
              <Button
                type="button"
                variant="ghost"
                className="w-full"
                onClick={() => setMode('signin')}
              >
                Já tenho conta
              </Button>
            </form>
          ) : (
            <form onSubmit={signIn} className="space-y-4">
              <div className="space-y-1.5">
                <Label htmlFor="email">E-mail</Label>
                <Input
                  id="email"
                  type="email"
                  autoComplete="email"
                  required
                  value={email}
                  onChange={(e) => setEmail(e.target.value)}
                />
              </div>
              <div className="space-y-1.5">
                <Label htmlFor="current">Senha</Label>
                <Input
                  id="current"
                  type="password"
                  autoComplete="current-password"
                  required
                  value={password}
                  onChange={(e) => setPassword(e.target.value)}
                />
              </div>
              <Button type="submit" className="w-full" disabled={busy}>
                {busy && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
                Entrar
              </Button>
              <Button
                type="button"
                variant="ghost"
                className="w-full"
                onClick={() => setMode('signup')}
              >
                Ainda não tenho conta
              </Button>
            </form>
          )}
        </CardContent>
      </Card>
    </div>
  )
}
