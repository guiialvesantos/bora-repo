import { useMemo } from 'react'
import {
  Bar, CartesianGrid, Cell, ComposedChart, Line, ReferenceLine, ResponsiveContainer,
  Tooltip, XAxis, YAxis,
} from 'recharts'
import { formatBRL, formatInt } from '@/lib/money'

/**
 * A venda semana a semana desde a PRIMEIRA venda — a curva de lançamento.
 *
 * ---------------------------------------------------------------------------
 * Por que o eixo é "semana 1, 2, 3…" e não uma data.
 *
 * A pergunta que a tela responde é sobre a IDADE do produto, não sobre o
 * calendário: dois lançamentos de meses diferentes só são comparáveis se as
 * duas semanas 1 ficarem uma em cima da outra. Num eixo de data cada produto
 * começaria num lugar e a comparação seria impossível.
 *
 * Por isso os baldes são ancorados no INÍCIO — o contrário dos baldes do
 * gráfico de histórico, que são ancorados no fim. Lá o que importa é a semana
 * mais recente; aqui, a semana 1. A consequência é que a semana INCOMPLETA é a
 * última, e ela é desenhada em tom claro e dita no tooltip: sem isso o gráfico
 * terminaria numa queda que é só o calendário não ter acabado.
 *
 * A linha é o sell-through ACUMULADO — quanto do que já foi comprado dessa peça
 * já virou venda até cada semana. Ela termina exatamente no número do KPI, e é
 * cheia (não tracejada como a de estoque) porque é EXATA: pela identidade de
 * conservação (inicial + recebido = vendido + final), o recebimento desconhecido
 * se cancela.
 * ---------------------------------------------------------------------------
 */

const SERIES_UNITS = 'hsl(var(--brand-600))'
const SERIES_PARTIAL = 'hsl(var(--brand-300))'
const SERIES_CUM = 'hsl(var(--violet-600))'

export interface LaunchWeek {
  week: number
  units: number
  revenue: number
  /** Dias do balde que já aconteceram. Menor que 7 só na última semana. */
  days: number
}

interface Point extends LaunchWeek {
  partial: boolean
  /** Fração do total comprado que já tinha saído até o fim desta semana. */
  cum: number
}

export function LaunchCurveChart({ weeks, denom }: {
  weeks: LaunchWeek[]
  /** Vendido desde sempre + saldo de hoje: tudo que um dia entrou. */
  denom: number
}) {
  const points = useMemo<Point[]>(() => {
    const out: Point[] = []
    let acc = 0
    for (const w of weeks) {
      acc += w.units
      out.push({ ...w, partial: w.days < 7, cum: denom > 0 ? (acc / denom) * 100 : 0 })
    }
    return out
  }, [weeks, denom])

  const maxUnits = useMemo(() => Math.max(1, ...points.map((p) => p.units)), [points])

  // Uns 12 rótulos no eixo, e a semana 1 sempre entre eles — é a referência de
  // tudo o que se lê aqui.
  const step = Math.max(1, Math.ceil(points.length / 12))
  const ticks = points.filter((p) => p.week === 1 || (p.week - 1) % step === 0).map((p) => p.week)

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center gap-x-4 gap-y-1.5 text-xs">
        <span className="flex items-center gap-1.5">
          <span className="h-2.5 w-2.5 shrink-0 rounded-[2px]" style={{ background: SERIES_UNITS }} />
          <span className="text-muted-foreground">Vendas na semana (un)</span>
        </span>
        <span className="flex items-center gap-1.5">
          <svg width="18" height="6" className="shrink-0" aria-hidden>
            <line x1="0" y1="3" x2="18" y2="3" stroke={SERIES_CUM} strokeWidth={2} />
          </svg>
          <span className="text-muted-foreground">Sell-through acumulado</span>
        </span>
        {points.at(-1)?.partial && (
          <span className="flex items-center gap-1.5">
            <span className="h-2.5 w-2.5 shrink-0 rounded-[2px]" style={{ background: SERIES_PARTIAL }} />
            <span className="text-muted-foreground">Semana em curso ({points.at(-1)!.days}d)</span>
          </span>
        )}
      </div>

      <ResponsiveContainer width="100%" height={280}>
        <ComposedChart data={points} margin={{ top: 8, right: 8, bottom: 0, left: 0 }}>
          <CartesianGrid vertical={false} stroke="hsl(var(--border))" strokeDasharray="3 3" />
          <XAxis
            dataKey="week"
            ticks={ticks}
            tickLine={false}
            axisLine={false}
            tick={{ fontSize: 11 }}
            className="fill-muted-foreground"
            tickFormatter={(v: number) => `S${v}`}
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
            yAxisId="c"
            orientation="right"
            domain={[0, 100]}
            width={44}
            tickLine={false}
            axisLine={false}
            tick={{ fontSize: 11, fill: SERIES_CUM }}
            tickFormatter={(v: number) => `${v}%`}
          />
          {/* Onde a peça já pagou metade do que dela se comprou. A linha cruzando
              essa marca cedo ou tarde é a leitura curta do gráfico. */}
          <ReferenceLine
            yAxisId="c"
            y={50}
            stroke={SERIES_CUM}
            strokeDasharray="2 4"
            strokeOpacity={0.45}
          />
          <Bar
            yAxisId="u"
            dataKey="units"
            radius={[2, 2, 0, 0]}
            maxBarSize={22}
            isAnimationActive={false}
          >
            {points.map((p) => (
              <Cell key={p.week} fill={p.partial ? SERIES_PARTIAL : SERIES_UNITS} />
            ))}
          </Bar>
          <Line
            yAxisId="c"
            type="monotone"
            dataKey="cum"
            stroke={SERIES_CUM}
            strokeWidth={2}
            dot={false}
            activeDot={{ r: 4, fill: SERIES_CUM, stroke: 'hsl(var(--surface))', strokeWidth: 2 }}
            isAnimationActive={false}
          />
          <Tooltip
            cursor={{ fill: 'hsl(var(--mono-100))' }}
            content={({ active, payload }) => {
              if (!active || !payload?.length) return null
              const p = payload[0].payload as Point
              return (
                <div className="rounded-sm border border-border bg-card px-3 py-2 text-xs shadow-dropdown">
                  <p className="mb-1 font-medium">
                    Semana {p.week}
                    {p.partial && (
                      <span className="ml-1 font-normal text-muted-foreground">
                        · em curso, {p.days} {p.days === 1 ? 'dia' : 'dias'}
                      </span>
                    )}
                  </p>
                  <p className="flex items-center gap-1.5">
                    <span className="h-2 w-2 rounded-[2px]" style={{ background: SERIES_UNITS }} />
                    <span className="font-data tabular-nums">{formatInt(p.units)} un</span>
                    {/* Venda sem preço existe: os itens que a Triana importou da
                        planilha não trazem `unit_price`. Escrever "R$ 0,00" ali
                        afirmaria que a peça saiu de graça; o que se sabe é que
                        não se sabe. */}
                    <span className="text-muted-foreground">
                      · {p.revenue > 0 ? formatBRL(p.revenue) : 'sem preço na base'}
                    </span>
                  </p>
                  <p className="flex items-center gap-1.5" style={{ color: SERIES_CUM }}>
                    <svg width="8" height="6" aria-hidden>
                      <line x1="0" y1="3" x2="8" y2="3" stroke={SERIES_CUM} strokeWidth={2} />
                    </svg>
                    <span className="font-data tabular-nums">
                      {p.cum.toLocaleString('pt-BR', { maximumFractionDigits: 1 })}% vendido até aqui
                    </span>
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
