/** Período nomeado. `range()` devolve `[de, até]` em ISO, ou nulos para "tudo". */
export type PeriodKey = 'all' | 'month' | 'last_month' | 'd7' | 'd30' | 'd90' | 'year'

const iso = (d: Date) => d.toISOString().slice(0, 10)

/**
 * Datas calculadas no fuso local do navegador, não em UTC. `sold_on` já foi
 * materializado em America/São_Paulo na 0003; ancorar o filtro em UTC faria
 * o dia 1º começar às 21h do dia 31.
 */
export function periodRange(key: PeriodKey, today = new Date()): [string | null, string | null] {
  const t = new Date(today.getFullYear(), today.getMonth(), today.getDate())
  const back = (days: number) => {
    const d = new Date(t)
    d.setDate(d.getDate() - days)
    return d
  }
  switch (key) {
    case 'all': return [null, null]
    case 'month': return [iso(new Date(t.getFullYear(), t.getMonth(), 1)), iso(t)]
    case 'last_month': return [
      iso(new Date(t.getFullYear(), t.getMonth() - 1, 1)),
      iso(new Date(t.getFullYear(), t.getMonth(), 0)),
    ]
    case 'd7': return [iso(back(6)), iso(t)]
    case 'd30': return [iso(back(29)), iso(t)]
    case 'd90': return [iso(back(89)), iso(t)]
    case 'year': return [iso(new Date(t.getFullYear(), 0, 1)), iso(t)]
  }
}

export const PERIOD_LABELS: Record<PeriodKey, string> = {
  all: 'Todo o período',
  month: 'Este mês',
  last_month: 'Mês passado',
  d7: 'Últimos 7 dias',
  d30: 'Últimos 30 dias',
  d90: 'Últimos 90 dias',
  year: 'Este ano',
}
