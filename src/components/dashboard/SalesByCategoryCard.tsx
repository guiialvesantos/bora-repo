import { useState } from 'react'
import { ChevronRight } from 'lucide-react'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { ChartNote } from '@/components/InfoHint'
import { formatBRL, formatInt } from '@/lib/money'
import { num } from '@/lib/replenishment-types'
import { useSalesByCategory } from '@/hooks/useSalesInsights'
import type { CensusFilters } from '@/hooks/useDashboardCensus'

/**
 * Venda por categoria, em dois níveis.
 *
 * A categoria do ERP é um CAMINHO ("Feminino -> Bottom -> Bermuda"), não um
 * rótulo. Achatar em folhas daria 34 linhas de cauda longa; mostrar só o
 * primeiro nível daria três barras e nenhuma ação. Então o primeiro nível fecha
 * o total e cada linha ABRE no resto do caminho.
 *
 * Fechada por padrão: quem olha o painel quer primeiro saber quanto é feminino
 * e quanto é masculino. O detalhe é a segunda pergunta, e só de uma linha.
 *
 * Obedece a canal e período; **não** obedece a depósito (o pedido não guarda de
 * qual prateleira a peça saiu).
 */

// Uma cor por linha do primeiro nível, na ordem do faturamento. São três ou
// quatro linhas na prática; a lista dá a volta e é o suficiente.
const TONES = [
  'hsl(var(--brand-600))',
  'hsl(var(--violet-600))',
  'hsl(var(--orange-600))',
  'hsl(var(--cyan-600))',
]

export function SalesByCategoryCard({ filters, periodLabel }: {
  filters: CensusFilters
  periodLabel: string
}) {
  const { data, isLoading } = useSalesByCategory(filters)
  const [open, setOpen] = useState<string | null>(null)

  const cats = data?.categories ?? []
  const total = num(data?.total_revenue)
  // Mede contra a LÍDER, não contra o total (mesma regra do cartão de cores):
  // com uma categoria em 60% as outras virariam traços iguais de nada.
  const top = cats.length > 0 ? num(cats[0].revenue) : 0
  const uncatRevenue = num(data?.uncategorized_revenue)
  const uncatUnits = num(data?.uncategorized_units)

  return (
    <Card className="flex flex-col">
      <CardHeader className="pb-3">
        <div className="flex flex-wrap items-start justify-between gap-2">
          <div>
            <CardTitle className="text-card-title">Vendas por categoria</CardTitle>
            <CardDescription>
              Faturamento por linha do catálogo · {periodLabel.toLowerCase()}
            </CardDescription>
          </div>
          <div className="flex items-center gap-2">
            {total > 0 && (
              <span className="rounded-xs bg-surface-inset px-2 py-1 text-micro text-muted-foreground">
                {formatBRL(total)}
              </span>
            )}
            <ChartNote label="Como a categoria é lida">
              <p>
                A categoria do ERP é um <strong className="text-ink">caminho</strong>
                {' '}("Feminino → Bottom → Bermuda"), e aqui ela abre em dois níveis. Achatar nas
                folhas daria 34 linhas de cauda longa; mostrar só o primeiro nível daria três
                barras e nenhuma ação.
              </p>
              <p>
                O segundo nível é o RESTO do caminho, não a folha: "Upper → Casual" e
                "Bottom → Casual" são duas coisas que viraram a mesma linha se fossem achatadas.
              </p>
              <p>Obedece a canal e período, nunca a depósito.</p>
            </ChartNote>
          </div>
        </div>
      </CardHeader>

      <CardContent className="flex-1 pt-0">
        {isLoading ? (
          <div className="space-y-2">
            {[0, 1, 2, 3].map((k) => (
              <div key={k} className="h-9 animate-pulse rounded-xs bg-surface-inset" />
            ))}
          </div>
        ) : !data?.has_categories ? (
          // Vazio por falta de DADO, não de venda — e são frases diferentes.
          <p className="py-6 text-center text-xs text-muted-foreground">
            Nenhum produto desta empresa tem categoria no catálogo. Sem isso não
            há o que separar — a venda do período aparece inteira no rodapé.
          </p>
        ) : cats.length === 0 ? (
          <p className="py-6 text-center text-xs text-muted-foreground">
            Nenhuma venda de produto categorizado no período.
          </p>
        ) : (
          <ul className="space-y-1">
            {cats.map((c, i) => {
              const revenue = num(c.revenue)
              const share = total > 0 ? revenue / total : 0
              const tone = TONES[i % TONES.length]
              const isOpen = open === c.name
              const hasChildren = c.children.length > 0
              return (
                <li key={c.name}>
                  <button
                    type="button"
                    disabled={!hasChildren}
                    onClick={() => setOpen(isOpen ? null : c.name)}
                    aria-expanded={hasChildren ? isOpen : undefined}
                    className="flex w-full items-center gap-2 rounded-xs px-1 py-1 text-left enabled:hover:bg-surface-inset disabled:cursor-default"
                  >
                    <ChevronRight
                      className={`h-3.5 w-3.5 shrink-0 text-muted-foreground transition-transform ${
                        isOpen ? 'rotate-90' : ''
                      } ${hasChildren ? '' : 'invisible'}`}
                      aria-hidden
                    />
                    <span className="w-24 shrink-0 truncate text-xs font-medium" title={c.name}>
                      {c.name}
                    </span>
                    <span className="h-2 min-w-0 flex-1 overflow-hidden rounded-full bg-surface-inset">
                      <span
                        className="block h-full rounded-full"
                        style={{
                          width: `${top > 0 ? Math.max(3, (revenue / top) * 100) : 0}%`,
                          backgroundColor: tone,
                        }}
                      />
                    </span>
                    <span className="w-14 shrink-0 text-right font-data text-xs tabular-nums text-muted-foreground">
                      {formatInt(num(c.units))} un
                    </span>
                    <span className="w-24 shrink-0 text-right font-data text-xs font-medium tabular-nums">
                      {formatBRL(revenue)}
                    </span>
                    <span className="w-11 shrink-0 text-right font-data text-xs tabular-nums text-muted-foreground">
                      {(share * 100).toFixed(1).replace('.', ',')}%
                    </span>
                  </button>

                  {isOpen && (
                    // O filho mede contra a PRÓPRIA categoria: comparar uma
                    // subdivisão do feminino com o total da empresa esconderia
                    // a diferença entre as subdivisões, que é o que se abriu
                    // para ver.
                    <ul className="ml-[22px] space-y-0.5 border-l border-border py-1 pl-3">
                      {c.children.map((ch) => {
                        const chRevenue = num(ch.revenue)
                        const chShare = revenue > 0 ? chRevenue / revenue : 0
                        return (
                          <li key={ch.name} className="flex items-center gap-2 py-0.5">
                            <span className="min-w-0 flex-1 truncate text-xs text-muted-foreground" title={ch.name}>
                              {ch.name}
                            </span>
                            <span className="w-14 shrink-0 text-right font-data text-xs tabular-nums text-muted-foreground">
                              {formatInt(num(ch.units))} un
                            </span>
                            <span className="w-24 shrink-0 text-right font-data text-xs tabular-nums">
                              {formatBRL(chRevenue)}
                            </span>
                            <span className="w-11 shrink-0 text-right font-data text-xs tabular-nums text-muted-foreground">
                              {(chShare * 100).toFixed(1).replace('.', ',')}%
                            </span>
                          </li>
                        )
                      })}
                    </ul>
                  )}
                </li>
              )
            })}
          </ul>
        )}
      </CardContent>

      {data && uncatRevenue > 0 && (
        <div className="border-t border-border px-5 py-2.5">
          {/* Fica de fora do total de propósito. Somar essa venda dentro de um
              balde "Outros" faria as barras fecharem com o faturamento e mentir
              sobre a cobertura do catálogo; omitir em silêncio faria elas
              somarem menos que o total sem explicação. */}
          <p className="text-micro text-muted-foreground">
            {formatBRL(uncatRevenue)} ({formatInt(uncatUnits)} peças) sem categoria no
            catálogo — fora das linhas acima.
          </p>
        </div>
      )}
    </Card>
  )
}
