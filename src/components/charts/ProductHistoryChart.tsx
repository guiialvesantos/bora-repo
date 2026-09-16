import { useMemo } from 'react'
import {
  Bar, CartesianGrid, ComposedChart, Line, ResponsiveContainer, Tooltip, XAxis, YAxis,
} from 'recharts'
import { formatBRL, formatInt } from '@/lib/money'

/**
 * Venda por dia contra a posição de estoque — as duas séries que respondem
 * "esse produto está vendendo, e o estoque acompanhou?".
 *
 * ---------------------------------------------------------------------------
 * A LINHA DE ESTOQUE É UM LIMITE SUPERIOR, E ISSO ESTÁ DESENHADO.
 *
 * Não existe histórico de posição de estoque: o ERP não datou nenhum
 * recebimento (`qty_received` é zero na base inteira). A única reconstrução
 * possível é andar para trás a partir do saldo de hoje somando o que saiu:
 *
 *     estoque(d-1) = estoque(d) + vendido(d)
 *
 * Isso ignora reposição. Como toda reposição só pode ter AUMENTADO o saldo, a
 * curva reconstruída fica em cima ou acima da real — nunca abaixo. Por isso é
 * tracejada, e por isso o rodapé diz o que ela é. Desenhá-la cheia, como se
 * fosse medida, seria inventar um histórico que a base não tem: no primeiro
 * reabastecimento o desenho subiria onde a realidade já tinha subido antes.
 *
 * O conserto de verdade é gravar a posição todo dia daqui para a frente. Até
 * lá, o tracejado é a forma honesta de mostrar a ordem de grandeza.
 * ---------------------------------------------------------------------------
 */

const SERIES_SALES = 'hsl(var(--brand-600))'
const SERIES_STOCK = 'hsl(var(--orange-600))'

/** Acima disso a barra diária vira um fio de 1px e o gráfico vira ruído. */
const WEEKLY_ABOVE = 120

export interface HistoryPoint {
  /** Fim do balde (yyyy-mm-dd). */
  date: string
  units: number
  revenue: number
  /** Posição reconstruída no fim do balde. */
  stock: number
}

function addDays(iso: string, n: number): string {
  const d = new Date(`${iso}T12:00:00`)
  d.setDate(d.getDate() + n)
  return d.toISOString().slice(0, 10)
}

function diffDays(a: string, b: string): number {
  return Math.round(
    (new Date(`${b}T12:00:00`).getTime() - new Date(`${a}T12:00:00`).getTime()) / 86_400_000,
  )
}

function shortDate(iso: string): string {
  const [, m, d] = iso.split('-')
  return `${d}/${m}`
}

/**
 * Monta a série completa: o RPC só manda os dias COM venda (mandar 180 zeros
 * pela rede para o navegador redesenhar não paga a viagem), então os zeros
 * nascem aqui, onde a janela já é conhecida.
 */
export function buildHistory(
  daily: { d: string; u: number; r: number }[],
  from: string,
  today: string,
  stockNow: number,
): { points: HistoryPoint[]; weekly: boolean } {
  const span = Math.max(1, diffDays(from, today) + 1)
  const byDay = new Map(daily.map((x) => [x.d, x]))

  const days: { date: string; units: number; revenue: number; stock: number }[] = []
  for (let i = 0; i < span; i++) {
    const date = addDays(from, i)
    const hit = byDay.get(date)
    days.push({ date, units: hit?.u ?? 0, revenue: hit?.r ?? 0, stock: 0 })
  }

  // De trás para frente: hoje é o único dia em que o saldo é medido.
  let running = stockNow
  for (let i = days.length - 1; i >= 0; i--) {
    days[i].stock = running
    running += days[i].units
  }

  if (span <= WEEKLY_ABOVE) return { points: days, weekly: false }

  // Baldes de 7 dias ancorados no FIM. O último balde é o que interessa (é o
  // mais recente e o único com saldo medido); ancorar no início deixaria um
  // resto solto justamente ali, com menos dias e por isso menos venda — uma
  // queda desenhada que não aconteceu.
  const points: HistoryPoint[] = []
  for (let end = days.length - 1; end >= 0; end -= 7) {
    const start = Math.max(0, end - 6)
    let units = 0
    let revenue = 0
    for (let i = start; i <= end; i++) {
      units += days[i].units
      revenue += days[i].revenue
    }
    points.unshift({ date: days[end].date, units, revenue, stock: days[end].stock })
  }
  return { points, weekly: true }
}

export function ProductHistoryChart({ points, weekly }: { points: HistoryPoint[]; weekly: boolean }) {
  const maxUnits = useMemo(
    () => Math.max(1, ...points.map((p) => p.units)),
    [points])
  const maxStock = useMemo(
    () => Math.max(1, ...points.map((p) => p.stock)),
    [points])

  // Passo do rótulo do eixo: uns 10 rótulos, nunca menos de um.
  const step = Math.max(1, Math.ceil(points.length / 10))
  const ticks = points.filter((_, i) => (points.length - 1 - i) % step === 0).map((p) => p.date)

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center gap-x-4 gap-y-1.5 text-xs">
        <span className="flex items-center gap-1.5">
          <span className="h-2.5 w-2.5 shrink-0 rounded-[2px]" style={{ background: SERIES_SALES }} />
          <span className="text-muted-foreground">
            Vendas{weekly ? ' por semana' : ' por dia'} (un)
          </span>
        </span>
        <span className="flex items-center gap-1.5">
          <svg width="18" height="6" className="shrink-0" aria-hidden>
            <line x1="0" y1="3" x2="18" y2="3" stroke={SERIES_STOCK} strokeWidth={2} strokeDasharray="4 3" />
          </svg>
          <span className="text-muted-foreground">Estoque estimado (limite superior)</span>
        </span>
      </div>

      <ResponsiveContainer width="100%" height={300}>
        <ComposedChart data={points} margin={{ top: 8, right: 8, bottom: 0, left: 0 }}>
          <CartesianGrid vertical={false} stroke="hsl(var(--border))" strokeDasharray="3 3" />
          <XAxis
            dataKey="date"
            ticks={ticks}
            tickLine={false}
            axisLine={false}
            tick={{ fontSize: 11 }}
            className="fill-muted-foreground"
            tickFormatter={shortDate}
          />
          <YAxis
            yAxisId="u"
            domain={[0, Math.ceil(maxUnits * 1.15)]}
            width={40}
            tickLine={false}
            axisLine={false}
            tick={{ fontSize: 11 }}
            className="fill-muted-foreground"
            allowDecimals={false}
          />
          <YAxis
            yAxisId="s"
            orientation="right"
            domain={[0, Math.ceil(maxStock * 1.1)]}
            width={48}
            tickLine={false}
            axisLine={false}
            tick={{ fontSize: 11, fill: SERIES_STOCK }}
            tickFormatter={(v: number) => formatInt(v)}
            allowDecimals={false}
          />
          <Bar
            yAxisId="u"
            dataKey="units"
            fill={SERIES_SALES}
            radius={[2, 2, 0, 0]}
            maxBarSize={weekly ? 18 : 10}
            isAnimationActive={false}
          />
          <Line
            yAxisId="s"
            type="monotone"
            dataKey="stock"
            stroke={SERIES_STOCK}
            strokeWidth={2}
            strokeDasharray="4 3"
            dot={false}
            activeDot={{ r: 4, fill: SERIES_STOCK, stroke: 'hsl(var(--surface))', strokeWidth: 2 }}
            isAnimationActive={false}
          />
          <Tooltip
            cursor={{ fill: 'hsl(var(--mono-100))' }}
            content={({ active, payload }) => {
              if (!active || !payload?.length) return null
              const p = payload[0].payload as HistoryPoint
              return (
                <div className="rounded-sm border border-border bg-card px-3 py-2 text-xs shadow-dropdown">
                  <p className="mb-1 font-medium">
                    {weekly ? 'Semana até ' : ''}{shortDate(p.date)}
                  </p>
                  <p className="flex items-center gap-1.5">
                    <span className="h-2 w-2 rounded-[2px]" style={{ background: SERIES_SALES }} />
                    <span className="font-data tabular-nums">{formatInt(p.units)} un</span>
                    {/* Nem toda venda tem preço na base (o que a Triana importou
                        da planilha não tem). "R$ 0,00" afirmaria que saiu de
                        graça — o que se sabe é que não se sabe. */}
                    <span className="text-muted-foreground">
                      · {p.revenue > 0 ? formatBRL(p.revenue) : 'sem preço na base'}
                    </span>
                  </p>
                  <p className="flex items-center gap-1.5" style={{ color: SERIES_STOCK }}>
                    <svg width="8" height="6" aria-hidden>
                      <line x1="0" y1="3" x2="8" y2="3" stroke={SERIES_STOCK} strokeWidth={2} />
                    </svg>
                    <span className="font-data tabular-nums">até {formatInt(p.stock)} un em estoque</span>
                  </p>
                </div>
              )
            }}
          />
        </ComposedChart>
      </ResponsiveContainer>
    </div>
  )
}
