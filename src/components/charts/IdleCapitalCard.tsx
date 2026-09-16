import { formatBRL, formatInt } from '@/lib/money'
import { IDLE_BUCKETS } from '@/lib/idle-capital'
import type { IdleBucketKey, IdleCapitalReport } from '@/lib/idle-capital'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import {
  Table, TableBody, TableCell, TableHead, TableHeader, TableRow,
} from '@/components/ui/table'

/**
 * Uma barra só, empilhada, em vez de pizza: a comparação aqui é "que fatia do
 * meu dinheiro está presa", e comprimento se compara a olho; ângulo não.
 *
 * E a tabela ao lado é metade do valor da peça — capital parado quase sempre
 * é Pareto. Saber que são R$ 68 mil não muda nada; saber que R$ 40 mil deles
 * estão em oito SKUs é uma tarde de trabalho.
 */

const BUCKET_LABEL: Record<IdleBucketKey, string> = {
  healthy: 'Saudável',
  excess: 'Acima do máximo',
  stale: 'Sem giro',
  discontinued: 'Fora de coleção',
}

function pct(v: number): string {
  return `${(v * 100).toLocaleString('pt-BR', { maximumFractionDigits: 1 })}%`
}

export function IdleCapitalCard({ report, loading }: {
  report: IdleCapitalReport
  loading?: boolean
}) {
  const { slices, offenders, totalCost, idleCost } = report

  return (
    <Card>
      <CardHeader className="pb-3">
        <CardTitle className="text-card-title">Capital parado</CardTitle>
        <CardDescription>
          A custo, não a preço de venda — é o dinheiro que já saiu do caixa. As faixas são
          exclusivas: cada peça conta uma vez, na causa mais grave.
        </CardDescription>
      </CardHeader>
      {loading ? (
        // A barra com as linhas ainda paginando fica 100% "Saudável" e as quatro
        // faixas zeradas: uma leitura tranquilizadora e falsa.
        <CardContent>
          <div className="h-8 animate-pulse rounded-sm bg-surface-inset" />
          <div className="mt-3 h-14 animate-pulse rounded-sm bg-surface-inset" />
        </CardContent>
      ) : (
      <CardContent className="space-y-5">
        <div>
          <div className="flex h-8 w-full overflow-hidden rounded-sm bg-surface-inset">
            {IDLE_BUCKETS.map((b) => {
              const slice = slices.find((s) => s.key === b.key)!
              if (slice.cost <= 0) return null
              return (
                <div
                  key={b.key}
                  className={`${b.fill} min-w-[3px]`}
                  style={{ width: totalCost > 0 ? `${(slice.cost / totalCost) * 100}%` : '0%' }}
                  title={`${b.label}: ${formatBRL(slice.cost)}`}
                />
              )
            })}
          </div>

          <div className="mt-3 grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
            {IDLE_BUCKETS.map((b) => {
              const slice = slices.find((s) => s.key === b.key)!
              return (
                <div key={b.key} className="flex gap-2">
                  <span className={`mt-1 h-3 w-3 shrink-0 rounded-xs ${b.fill}`} />
                  <div className="min-w-0">
                    <p className="text-body-sm font-medium leading-tight">{b.label}</p>
                    <p className="font-data text-sm font-semibold tabular-nums">
                      {formatBRL(slice.cost)}
                      <span className="ml-1.5 text-xs font-normal text-muted-foreground">
                        {totalCost > 0 ? pct(slice.cost / totalCost) : '—'}
                      </span>
                    </p>
                    <p className="text-xs text-muted-foreground">
                      {formatInt(slice.pieces)} pç · {b.hint}
                    </p>
                  </div>
                </div>
              )
            })}
          </div>
        </div>

        {offenders.length > 0 && (
          <div>
            <p className="mb-2 text-label text-muted-foreground">
              Onde o dinheiro está preso — {offenders.length} maiores, {' '}
              {idleCost > 0
                ? pct(offenders.reduce((s, o) => s + o.cost, 0) / idleCost)
                : '—'}{' '}
              do total parado
            </p>
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>SKU</TableHead>
                  <TableHead>Motivo</TableHead>
                  <TableHead className="text-right">Peças</TableHead>
                  <TableHead className="text-right">Cobertura</TableHead>
                  <TableHead className="text-right">Capital</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {offenders.map((o) => (
                  <TableRow key={`${o.productId}-${o.bucket}`}>
                    <TableCell className="max-w-[22rem]">
                      <span className="font-data font-medium">{o.sku}</span>
                      {o.name && (
                        <span className="ml-2 text-xs text-muted-foreground">{o.name}</span>
                      )}
                    </TableCell>
                    <TableCell className="text-body-sm text-muted-foreground">
                      {BUCKET_LABEL[o.bucket]}
                    </TableCell>
                    <TableCell className="text-right font-data tabular-nums">
                      {formatInt(o.pieces)}
                    </TableCell>
                    <TableCell className="text-right font-data tabular-nums">
                      {o.coverageWeeks == null
                        ? '—'
                        : `${o.coverageWeeks.toLocaleString('pt-BR', { maximumFractionDigits: 0 })} sem`}
                    </TableCell>
                    <TableCell className="text-right font-data font-semibold tabular-nums">
                      {formatBRL(o.cost)}
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </div>
        )}
      </CardContent>
      )}
    </Card>
  )
}
