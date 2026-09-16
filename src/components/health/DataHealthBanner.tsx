import { Link } from 'react-router-dom'
import { AlertTriangle, ArrowRight } from 'lucide-react'
import { useDataHealth } from '@/hooks/useDataHealth'
import { KIND_LABEL } from '@/lib/replenishment-types'

/**
 * O aviso que aparece em todas as rotas.
 *
 * Avisa, não bloqueia. Quem bloqueia é a tela de pedido, e só ela — um banner
 * que trava o sistema inteiro treina o usuário a ignorar banner, e aí o aviso
 * que importava passa batido junto.
 */
export function DataHealthBanner() {
  const { data } = useDataHealth()
  if (!data) return null

  const problems: string[] = []

  for (const s of data.sources) {
    if (s.missing) problems.push(`${KIND_LABEL[s.kind]} nunca foi importado`)
    else if (s.stale) problems.push(`${KIND_LABEL[s.kind]} está desatualizado`)
  }

  // O achado 1 do `docs/divergencias.md`, medido no dado que está no banco
  // agora — e não no exemplo congelado do documento.
  if (data.checks.recent_window_dead) {
    problems.push('a janela de 28 dias não alcança nenhuma venda: a demanda estimada está pela metade')
  }

  if (data.checks.transit_qty_lost_to_whitespace > 0) {
    problems.push(
      `${data.checks.transit_qty_lost_to_whitespace} peças em trânsito invisíveis por espaço no código`)
  }

  if (problems.length === 0) return null

  return (
    // Faixa tonal do ramp `warning`, não âmbar com opacidade: no Infinify o
    // aviso é `warning-200` de fundo com `warning-700` de texto, cores cheias
    // do ramp. `bg-amber-500/10` além de estar fora do sistema muda de tom
    // conforme o que estiver atrás, o que num painel branco some.
    <div className="rounded-lg border border-warning-300 bg-warning-200 px-4 py-2.5">
      <div className="flex items-start gap-2.5 text-sm">
        <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0 text-warning-700" />
        <p className="text-warning-900">
          {problems.slice(0, 2).join('; ')}
          {problems.length > 2 && ` e mais ${problems.length - 2}`}.{' '}
          <Link
            to="/saude-dos-dados"
            className="inline-flex items-center gap-1 font-medium underline underline-offset-2"
          >
            Ver detalhes <ArrowRight className="h-3 w-3" />
          </Link>
        </p>
      </div>
    </div>
  )
}
