import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { ChartNote } from '@/components/InfoHint'
import { colorLabel, colorSwatch, isPale } from '@/lib/color-swatch'
import { formatInt } from '@/lib/money'
import { num } from '@/lib/replenishment-types'
import { useTopColors } from '@/hooks/useSalesInsights'
import type { CensusFilters } from '@/hooks/useDashboardCensus'

/**
 * O que mais sai, por cor.
 *
 * A cor não é um campo do catálogo — o Tiny devolve a variação como nome
 * composto ("Legging Chicago - Preto - M") e a cor é extraída dele no banco
 * (0030). Isso tem consequência visível: em uns poucos SKUs o nome do modelo
 * está escrito onde deveria estar o atributo, e vaza para cá como se fosse cor.
 * O rodapé diz isso em uma linha, porque um número que parece exato e não é
 * custa mais caro do que um número com ressalva.
 *
 * Obedece a canal e período; **não** obedece a depósito. O pedido não guarda de
 * qual prateleira a peça saiu, e isso não mudaria o fato de que aquela cor
 * vendeu.
 */
export function TopColorsCard({ filters, periodLabel }: {
  filters: CensusFilters
  periodLabel: string
}) {
  const { data, isLoading } = useTopColors(filters)

  const colors = data?.colors ?? []
  const total = num(data?.total_units)
  // A barra mede contra a LÍDER, não contra o total: com uma cor em 40% e as
  // outras em 3%, barras proporcionais ao total viram sete traços iguais de
  // nada. A barra ordena, o percentual ao lado é que informa.
  const top = colors.length > 0 ? num(colors[0].units) : 0

  return (
    <Card className="flex flex-col">
      <CardHeader className="pb-3">
        <div className="flex flex-wrap items-start justify-between gap-2">
          <div>
            <CardTitle className="text-card-title">Cores mais vendidas</CardTitle>
            <CardDescription>
              Distribuição de vendas por cor · {periodLabel.toLowerCase()}
            </CardDescription>
          </div>
          <div className="flex items-center gap-2">
            {total > 0 && (
              <span className="rounded-xs bg-surface-inset px-2 py-1 text-micro text-muted-foreground">
                {formatInt(total)} peças
              </span>
            )}
            <ChartNote label="De onde sai a cor">
              <p>
                Não existe campo de cor no catálogo: ela é lida do{' '}
                <strong className="text-ink">nome da variação</strong>, tirando o nome do produto
                pai e descartando o que parece tamanho.
              </p>
              <p>
                Onde o catálogo escreve o modelo no lugar do atributo, ele aparece aqui como se
                fosse cor. Uma lista de "palavras que são cor" trocaria esse erro visível por um
                silencioso, que comeria a venda de toda cor que ninguém lembrou de listar.
              </p>
              <p>Obedece a canal e período, nunca a depósito — pedido não diz de qual prateleira a peça saiu.</p>
            </ChartNote>
          </div>
        </div>
      </CardHeader>

      <CardContent className="flex-1 pt-0">
        {isLoading ? (
          <div className="space-y-2">
            {[0, 1, 2, 3, 4, 5].map((k) => (
              <div key={k} className="h-7 animate-pulse rounded-xs bg-surface-inset" />
            ))}
          </div>
        ) : !data?.has_variants ? (
          // Vazio por falta de DADO, não por falta de venda — e são frases
          // diferentes. Nesta empresa nenhum produto tem variação, então não há
          // de onde tirar cor; dizer "nenhuma venda" seria mentira.
          <p className="py-6 text-center text-xs text-muted-foreground">
            Esta empresa não tem produtos com variação, e a cor vem do nome da
            variação. Sem isso não há o que separar.
          </p>
        ) : colors.length === 0 ? (
          <p className="py-6 text-center text-xs text-muted-foreground">
            Nenhuma venda de produto com variação no período.
          </p>
        ) : (
          <ul className="space-y-1.5">
            {colors.map((c) => {
              const units = num(c.units)
              const hex = colorSwatch(c.color)
              const share = total > 0 ? units / total : 0
              return (
                <li key={c.color} className="flex items-center gap-2.5">
                  <span
                    className={`h-3 w-3 shrink-0 rounded-full ${
                      hex ? '' : 'border border-dashed border-border'
                    }`}
                    style={hex
                      ? {
                        backgroundColor: hex,
                        ...(isPale(hex)
                          ? { boxShadow: 'inset 0 0 0 1px hsl(var(--border))' }
                          : {}),
                      }
                      : undefined}
                    title={hex ? undefined : 'Cor não reconhecida'}
                    aria-hidden
                  />
                  <span className="w-28 shrink-0 truncate text-xs" title={colorLabel(c.color)}>
                    {colorLabel(c.color)}
                  </span>
                  <span className="w-10 shrink-0 text-right font-data text-xs tabular-nums text-muted-foreground">
                    {formatInt(units)}
                  </span>
                  <span className="h-2 min-w-0 flex-1 overflow-hidden rounded-full bg-surface-inset">
                    {/* O contorno da cor clara vai por `inset ring`, não por
                        `border`: numa barra de 8px a borda come a altura toda e
                        o branco desenha um risco, não uma barra. */}
                    <span
                      className={`block h-full rounded-full ${hex ? '' : 'bg-muted-foreground/40'}`}
                      style={{
                        width: `${top > 0 ? Math.max(3, (units / top) * 100) : 0}%`,
                        ...(hex ? { backgroundColor: hex } : {}),
                        ...(hex && isPale(hex)
                          ? { boxShadow: 'inset 0 0 0 1px hsl(var(--border))' }
                          : {}),
                      }}
                    />
                  </span>
                  <span className="w-11 shrink-0 text-right font-data text-xs font-medium tabular-nums">
                    {(share * 100).toFixed(1).replace('.', ',')}%
                  </span>
                </li>
              )
            })}
          </ul>
        )}
      </CardContent>

      {/* Só o que muda com o dado fica visível: quantas cores ficaram de fora.
          A ressalva sobre COMO a cor é lida é sempre a mesma e foi para o "i". */}
      {data && data.has_variants && data.total_colors > colors.length && (
        <div className="border-t border-border px-5 py-2.5">
          <p className="text-micro text-muted-foreground">
            {formatInt(data.total_colors)} cores no período; as {colors.length} maiores acima.
          </p>
        </div>
      )}
    </Card>
  )
}
