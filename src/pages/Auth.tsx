import { useState } from 'react'
import { Navigate } from 'react-router-dom'
import { Check, Eye, EyeOff } from 'lucide-react'
import { supabase } from '@/lib/supabase'
import { useAuth } from '@/contexts/AuthContext'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { LogoLoader, LogoMark, LogoWordmark } from '@/components/brand/Logo'
import { cn } from '@/lib/utils'

/**
 * A porta de entrada.
 *
 * O desenho antigo era um cartão de 288px no meio de uma tela vazia: o sistema
 * põe conteúdo em peça branca sobre fundo cinza porque um painel precisa se
 * separar dos painéis VIZINHOS — e aqui não há vizinho nenhum. O cinza deixava
 * de ser moldura e virava só vazio, com a marca perdida no centro.
 *
 * Trocado por duas colunas: a da esquerda é a única superfície cheia da marca em
 * todo o sistema, e a da direita é branca com o formulário. O `theme.css` diz em
 * letras maiúsculas que o azul "é o acento que carrega toda a vida da tela,
 * porque o resto é branco, cinza e tabela" — esta é a tela em que ele pode ser
 * superfície, porque não disputa com dado nenhum.
 *
 * Abaixo de `lg` a coluna azul some inteira e sobra o formulário numa página
 * branca. Não vira cartão de novo: em telefone o cartão tem a largura da tela e
 * a borda só desenha um retângulo em volta de tudo.
 */

/** O que o sistema faz, em três linhas verificáveis — não promessa de vendas. */
const PROOF = [
  'Estoque de segurança, ponto de pedido e estoque máximo, calculados por SKU.',
  'Pedido de compra pronto, com custo por linha e total.',
  'Todo número rastreável até a versão do parâmetro que o gerou.',
]

/**
 * O Supabase responde em inglês e com o vocabulário dele.
 *
 * Antes isso ia cru para um toast: quem errava a senha via "Invalid login
 * credentials" numa notificação que sumia sozinha em segundos — em inglês, e
 * longe do campo que precisava ser corrigido. Erro de login tem que ficar
 * PARADO na tela, porque o passo seguinte é redigitar.
 *
 * O `default` devolve a mensagem original de propósito: inventar um "algo deu
 * errado" genérico esconderia justamente o caso que eu não previ aqui.
 */
function humanAuthError(message: string): string {
  const m = message.toLowerCase()
  if (m.includes('invalid login credentials')) return 'E-mail ou senha incorretos.'
  if (m.includes('email not confirmed')) return 'Confirme seu e-mail antes de entrar.'
  if (m.includes('too many requests') || m.includes('rate limit')) {
    return 'Tentativas demais em pouco tempo. Espere um minuto e tente de novo.'
  }
  if (m.includes('failed to fetch') || m.includes('network')) {
    return 'Não deu para falar com o servidor. Verifique a conexão e tente de novo.'
  }
  return message
}

export default function Auth() {
  const { session, loading } = useAuth()
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [reveal, setReveal] = useState(false)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  // Era `return null`. Esta é a primeira tela de quem abre o sistema: o branco
  // dura o tempo de o Supabase responder se já existe sessão, e nesse intervalo
  // a página parecia não ter carregado.
  if (loading) {
    return (
      <div className="flex min-h-screen items-center justify-center bg-surface p-6">
        <LogoLoader className="w-[76px] text-brand-600" />
      </div>
    )
  }
  if (session) return <Navigate to="/painel" replace />

  async function signIn(e: React.FormEvent) {
    e.preventDefault()
    setBusy(true)
    setError(null)
    const { error: authError } = await supabase.auth.signInWithPassword({ email, password })
    setBusy(false)
    if (authError) setError(humanAuthError(authError.message))
  }

  return (
    <div className="grid min-h-screen bg-surface lg:grid-cols-[1.05fr_1fr]">
      {/* ---------------------------------------------------------------
          A coluna da marca. `overflow-hidden` porque as lâminas sangram
          pela borda de baixo: é a geometria da própria marca ampliada,
          não um ornamento importado de fora.
          --------------------------------------------------------------- */}
      <aside className="relative hidden flex-col justify-between overflow-hidden bg-brand-600 p-12 xl:p-16 lg:flex">
        {/* Dimensionada pela ALTURA, e em 150% dela: o topo e a base das lâminas
            são retas horizontais, e qualquer tamanho que caiba no painel deixa
            uma delas atravessando o azul de ponta a ponta como emenda. Em 150%
            as duas ficam fora do quadro em qualquer viewport, e o que sobra na
            tela são só as diagonais. A largura vem sozinha da `viewBox` (o
            desenho é 1,77× mais largo que alto), então ela também transborda e
            o que se vê é a primeira lâmina e meia, não a marca inteira posando
            no meio do painel. */}
        <LogoMark
          className="pointer-events-none absolute -top-1/4 -left-1/4 h-[150%] w-auto max-w-none text-white/[0.07]"
        />

        <LogoWordmark className="relative h-auto w-[196px] text-white" />

        <div className="relative max-w-md">
          <h2 className="text-[32px] font-bold leading-[40px] tracking-[-0.02em] text-white">
            Comprar o que falta, na quantidade que a venda pede.
          </h2>
          <ul className="mt-8 space-y-4">
            {PROOF.map((line) => (
              <li key={line} className="flex gap-3 text-base leading-6 text-brand-200">
                <Check className="mt-0.5 h-5 w-5 shrink-0 text-brand-300" strokeWidth={2} />
                {line}
              </li>
            ))}
          </ul>
        </div>

        <p className="relative text-body-sm text-brand-300">borarepo.linqer.com.br</p>
      </aside>

      {/* ---------------------------------------------------------------
          A coluna do formulário.
          --------------------------------------------------------------- */}
      <main className="flex items-center justify-center px-6 py-12">
        <div className="w-full max-w-[380px]">
          {/* A marca só aparece aqui quando a coluna azul não existe. Repetir
              nas duas colunas poria o mesmo logo duas vezes na mesma tela. */}
          <LogoWordmark className="mb-10 h-auto w-[168px] text-brand-600 lg:hidden" />

          <h1 className="text-page-title text-foreground">Entrar</h1>
          {/* Não existe cadastro aberto: todo acesso nasce de um convite. Dizer
              isso aqui evita a pessoa procurar um "criar conta" que não há. */}
          <p className="mt-1.5 text-base text-muted-foreground">
            Use o e-mail em que você recebeu o convite.
          </p>

          <form onSubmit={signIn} className="mt-8 space-y-5">
            <div className="space-y-2">
              <Label htmlFor="email">E-mail</Label>
              <Input
                id="email"
                type="email"
                autoComplete="email"
                autoFocus
                required
                placeholder="voce@empresa.com.br"
                aria-invalid={error ? true : undefined}
                className={cn('h-control-lg', error && 'border-error-600')}
                value={email}
                onChange={(e) => setEmail(e.target.value)}
              />
            </div>

            <div className="space-y-2">
              <Label htmlFor="password">Senha</Label>
              <div className="relative">
                <Input
                  id="password"
                  type={reveal ? 'text' : 'password'}
                  autoComplete="current-password"
                  required
                  aria-invalid={error ? true : undefined}
                  className={cn('h-control-lg pr-11', error && 'border-error-600')}
                  value={password}
                  onChange={(e) => setPassword(e.target.value)}
                />
                {/* Mostrar a senha é o que salva quem errou uma letra num
                    teclado de celular — sem isso a única saída é apagar tudo.
                    `tabIndex={-1}` porque o Tab tem que ir do campo direto
                    para o botão de entrar, não parar num olho. */}
                <button
                  type="button"
                  tabIndex={-1}
                  onClick={() => setReveal((v) => !v)}
                  aria-label={reveal ? 'Ocultar senha' : 'Mostrar senha'}
                  className="absolute right-1 top-1 flex h-10 w-10 items-center justify-center rounded-sm text-mono-500 transition-ui hover:text-mono-900"
                >
                  {reveal ? <EyeOff className="h-4 w-4" /> : <Eye className="h-4 w-4" />}
                </button>
              </div>
            </div>

            {/* Lavagem clara com texto escuro do mesmo matiz — a receita de chip
                do Infinify. `role="alert"` para o leitor de tela anunciar sem
                precisar que o foco passe por aqui. */}
            {error && (
              <p
                role="alert"
                className="rounded-sm border border-error-300 bg-error-100 px-3 py-2.5 text-body-sm text-error-800"
              >
                {error}
              </p>
            )}

            <Button
              type="submit"
              size="lg"
              disabled={busy}
              className={cn(
                'w-full',
                // Enquanto a requisição corre o botão está `disabled` para não
                // enviar duas vezes — mas NÃO deve parecer desativado: o azul
                // 300 do estado desabilitado engoliria a marca animada, que
                // herda a cor do texto. Ele continua azul cheio, trabalhando.
                busy && 'disabled:bg-brand-600 disabled:text-white [&_svg]:h-auto [&_svg]:w-8',
              )}
            >
              {busy ? <LogoLoader /> : 'Entrar'}
            </Button>
          </form>
        </div>
      </main>
    </div>
  )
}
