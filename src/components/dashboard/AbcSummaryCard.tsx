import { useMemo } from 'react'
import { Link } from 'react-router-dom'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { formatBRLCompact, formatInt } from '@/lib/money'
import { num } from '@/lib/replenishment-types'
import type { AbcClass, SnapshotItem } from '@/lib/replenishment-types'

/**
 * As mesmas três tintas da tela Curva ABC. Repetidas aqui de propósito, e não
 * importadas de lá: se um dia a página mudar a paleta, este cartão é um resumo
 * DELA e tem que mudar junto — o acoplamento é a intenção.
 *
 * A/B/C é categoria, não semáforo: um item C não está com problema, ele é
 * cauda. Por isso saem da paleta categórica (azul → violeta → cyan) e não de
 * verde/âmbar/vermelho.
 */
const TONE: Record<AbcClass, string> = {
  A: 'border-brand-300 bg-brand-100 text-brand-700',
  B: 'border-violet-300 bg-violet-200 text-violet-800',
  C: 'border-cyan-300 bg-cyan-100 text-cyan-1000',
}

const CLASSES: AbcClass[] = ['A', 'B', 'C']

/**
 * Cobertura em dias, pintada só quando há o que dizer.
 *
 * Zero estoque é ruptura — vermelho. Abaixo do lead time é o aviso que
 * interessa: significa que a peça acaba ANTES de a reposição conseguir chegar,
 * ainda que o pedido saísse hoje. Acima disso o número sai em tinta normal, e
 * isso não é omissão: cobertura alta não é boa notícia (é capital parado, que
 * tem cartão próprio nesta mesma tela), então pintá-la de verde seria elogiar
 * o defeito.
 */
function Cover({ days, leadTime }: { days: number | null; leadTime: number }) {
  if (days == null) {
    return <span className="text-xs text-muted-foreground">Sem venda</span>
  }
  if (days === 0) {
    return (
      <span className="rounded-xs bg-danger-soft px-1.5 py-0.5 text-micro font-medium text-destructive">
        Sem estoque
      </span>
    )
  }
  const short = days < leadTime
  return (
    <span
      className={`font-data text-xs tabular-nums ${
        short ? 'rounded-xs bg-warning-100 px-1.5 py-0.5 font-medium text-warning-800' : 'text-ink'
      }`}
      title={short
        ? `Acaba em ${formatInt(days)} dias — antes dos ${formatInt(leadTime)} dias de reposição.`
        : undefined}
    >
      {formatInt(days)}d
    </span>
  )
}

/**
 * O topo da curva ABC, no Painel.
 *
 * Sai das MESMAS linhas do snapshot que o resto da tela — já reancoradas no
 * depósito escolhido — e não de consulta própria. Duas fontes para a mesma
 * curva acabariam discordando no dia em que alguém filtrasse um depósito.
 *
 * A ordem é a do acumulado (`abc_cum_pct`), não a do faturamento. Parece o
 * mesmo e não é: o desempate do motor é `source_row`, e reordenar por receita
 * trocaria de lugar dois itens de mesma receita — o cartão mostraria uma
 * sequência que não é a que gerou as classes.
 */
export function AbcSummaryCard({ items, leadTimeDays, loading }: {
  items: SnapshotItem[]
  leadTimeDays: number
  loading?: boolean
}) {
  const { rows, counts, hidden, total } = useMemo(() => {
    const ranked = items
      .filter((i) => i.abc_class != null)
      .sort((a, b) => num(a.abc_cum_pct) - num(b.abc_cum_pct))

    const counts = { A: 0, B: 0, C: 0 } as Record<AbcClass, number>
    let total = 0
    for (const i of ranked) {
      counts[i.abc_class as AbcClass] += 1
      total += num(i.weekly_revenue) * 52
    }

    const rows = ranked.slice(0, 5).map((i) => {
      const daily = num(i.weekly_blended) / 7
      const stock = num(i.stock_total)
      return {
        id: i.product_id,
        cls: i.abc_class as AbcClass,
        name: i.name ?? i.sku ?? '—',
        sku: i.sku,
        revenue: num(i.weekly_revenue) * 52,
        cover: daily > 0 ? Math.round(stock / daily) : stock > 0 ? null : 0,
      }
    })

    return { rows, counts, hidden: Math.max(0, ranked.length - rows.length), total }
  }, [items])

  return (
    <Card className="flex flex-col">
      <CardHeader className="pb-3">
        <div className="flex flex-wrap items-start justify-between gap-2">
          <div>
            <CardTitle className="text-card-title">Curva ABC</CardTitle>
            <CardDescription>Classificação de produtos por faturamento</CardDescription>
          </div>
          <div className="flex items-center gap-1">
            {CLASSES.map((c) => (
              <span
                key={c}
                className={`rounded-xs border px-1.5 py-0.5 text-micro font-medium ${TONE[c]}`}
              >
                {c}: {counts[c]}
              </span>
            ))}
          </div>
        </div>
      </CardHeader>

      <CardContent className="flex-1 pt-0">
        {loading ? (
          <div className="space-y-2">
            {[0, 1, 2, 3, 4].map((k) => (
              <div key={k} className="h-9 animate-pulse rounded-xs bg-surface-inset" />
            ))}
          </div>
        ) : rows.length === 0 ? (
          <p className="py-6 text-center text-xs text-muted-foreground">
            Nenhum produto classificado. A curva só roda sobre itens em coleção.
          </p>
        ) : (
          <ul className="divide-y divide-border">
            {rows.map((r) => (
              <li key={r.id} className="flex items-center gap-3 py-2">
                <span
                  className={`flex h-6 w-6 shrink-0 items-center justify-center rounded-xs border text-micro font-bold ${TONE[r.cls]}`}
                >
                  {r.cls}
                </span>
                <span className="min-w-0 flex-1 truncate text-xs" title={r.sku ?? undefined}>
                  {r.name}
                </span>
                <span className="shrink-0 text-right">
                  <span className="font-data text-xs font-medium tabular-nums">
                    {total > 0
                      ? `${((r.revenue / total) * 100).toFixed(1).replace('.', ',')}%`
                      : '—'}
                  </span>
                  <span className="ml-2 font-data text-micro tabular-nums text-muted-foreground">
                    {formatBRLCompact(r.revenue)}
                  </span>
                </span>
                <span className="w-16 shrink-0 text-right">
                  <Cover days={r.cover} leadTime={leadTimeDays} />
                </span>
              </li>
            ))}
          </ul>
        )}
      </CardContent>

      {/* O rodapé diz a base do número e leva para a curva inteira. "Anualizado"
          não é enfeite: é a mesma base que o motor usa para classificar
          (`weekly_revenue × 52`), e sem dizer isso alguém compararia este valor
          com a venda do período escolhido na barra e acharia que um dos dois
          está errado. */}
      <div className="flex items-center justify-between border-t border-border px-5 py-2.5">
        <span className="text-micro text-muted-foreground">
          Faturamento anualizado · cobertura ao ritmo de venda atual
        </span>
        {hidden > 0 && (
          <Link to="/curva-abc" className="text-micro font-medium text-brand-600 hover:underline">
            +{formatInt(hidden)} produtos
          </Link>
        )}
      </div>
    </Card>
  )
}
