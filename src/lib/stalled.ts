import { num } from './replenishment-types'
import type { StalledRow } from '@/hooks/useStalled'

/**
 * De "parou de vender" para "faça isto".
 *
 * Uma lista de seiscentos SKUs parados não é uma resposta — é a mesma pergunta
 * escrita por extenso. O que decide a ação não é o tempo parado, é POR QUE
 * parou, e são causas com saídas incompatíveis:
 *
 *   1. fora de coleção     — já foi decidido que não volta; só resta escoar
 *   2. a grade ainda vende — o modelo gira, o tamanho é que sobra
 *   3. nunca vendeu nada   — é mais provável que seja o anúncio do que o produto
 *   4. o resto             — parou mesmo
 *
 * A ordem acima é de precedência, não de gravidade. "Fora de coleção" vem
 * primeiro porque desliga a pergunta da grade: não se corrige o sortimento de
 * uma linha que não será recomprada.
 *
 * ---------------------------------------------------------------------------
 * O CORTE ENTRE LIQUIDAR E DEIXAR ESGOTAR É DE PARETO, NÃO DE VALOR FIXO.
 *
 * "Liquidar acima de R$ 2.000" funcionaria numa empresa e em nenhuma outra —
 * R$ 2.000 parados são a metade do problema numa loja de semijoias e um arredondamento
 * numa de activewear. Então o corte é relativo à própria empresa: ordenados por
 * capital, os itens que juntos formam os primeiros 80% do dinheiro parado
 * merecem campanha; a cauda sai no arrasto e não paga a atenção que custaria.
 *
 * É a mesma técnica da curva ABC que já está no sistema, aplicada ao avesso —
 * lá para achar o que sustenta o faturamento, aqui para achar o que prende o
 * caixa.
 * ---------------------------------------------------------------------------
 */

export type StalledAction = 'grade' | 'anuncio' | 'liquidar' | 'esgotar'

export const STALLED_ACTIONS: {
  key: StalledAction
  label: string
  hint: string
  /** Frase no imperativo, para a coluna da tabela. */
  advice: string
  /** Tom do selo — cinza para o que só exige atenção, âmbar para o que exige dinheiro. */
  tone: 'bad' | 'warn' | 'muted'
}[] = [
  {
    key: 'liquidar',
    label: 'Liquidar',
    hint: 'concentra o capital parado',
    advice: 'Desconto progressivo ou kit — o dinheiro preso aqui já custou mais que a margem.',
    tone: 'bad',
  },
  {
    key: 'grade',
    label: 'Ajustar a grade',
    hint: 'o modelo vende, este tamanho não',
    advice: 'Não é o produto: é o sortimento. Comprar menos deste tamanho na próxima grade.',
    tone: 'warn',
  },
  {
    key: 'anuncio',
    label: 'Conferir o anúncio',
    hint: 'nunca vendeu uma peça',
    advice: 'Antes de descontar, ver se está publicado, com foto e preço — pode não ser o produto.',
    tone: 'warn',
  },
  {
    key: 'esgotar',
    label: 'Deixar esgotar',
    hint: 'cauda: não paga campanha',
    advice: 'Só não repor. Campanha para esta faixa custa mais atenção do que devolve.',
    tone: 'muted',
  },
]

export const ACTION_BY_KEY = Object.fromEntries(
  STALLED_ACTIONS.map((a) => [a.key, a]),
) as Record<StalledAction, (typeof STALLED_ACTIONS)[number]>

export interface StalledItem {
  row: StalledRow
  stock: number
  cost: number
  days: number | null
  action: StalledAction
  /** Fração acumulada do capital parado até esta linha, 0–1. */
  cumShare: number
}

export interface StalledReport {
  items: StalledItem[]
  cost: number
  pieces: number
  /** Capital parado sobre o capital em estoque, 0–1. */
  share: number
  byAction: Record<StalledAction, { skus: number; pieces: number; cost: number }>
}

/** Fatia do capital parado que ainda vale campanha. */
const PARETO = 0.8

/** Irmão "vivo" = vendeu nos últimos 90 dias (a mesma janela contada na 0036). */
function inLiveGrade(r: StalledRow): boolean {
  return r.grade_size > 1 && r.grade_alive > 0
}

export function analyseStalled(
  rows: StalledRow[],
  minDays: number,
  stockCost: number,
): StalledReport {
  // `days === null` é "nunca vendeu", que passa em qualquer janela: não há
  // data para comparar e a ausência de venda é mais velha que o corte.
  const kept = rows
    .filter((r) => r.days == null || r.days >= minDays)
    .map((r) => ({ row: r, stock: num(r.stock), cost: num(r.cost), days: r.days }))
    .sort((a, b) => b.cost - a.cost)

  const cost = kept.reduce((s, x) => s + x.cost, 0)
  const pieces = kept.reduce((s, x) => s + x.stock, 0)

  const byAction: StalledReport['byAction'] = {
    grade: { skus: 0, pieces: 0, cost: 0 },
    anuncio: { skus: 0, pieces: 0, cost: 0 },
    liquidar: { skus: 0, pieces: 0, cost: 0 },
    esgotar: { skus: 0, pieces: 0, cost: 0 },
  }

  const items: StalledItem[] = []
  let acc = 0
  for (const k of kept) {
    // O item que CRUZA os 80% entra na fatia de cima: ele é parte da razão de
    // ela chegar lá. Cortar antes dele deixaria de fora justamente a linha que
    // fechou a conta.
    const wasInside = cost > 0 && acc / cost < PARETO
    acc += k.cost
    const cumShare = cost > 0 ? acc / cost : 0

    const r = k.row
    const action: StalledAction = r.discontinued
      ? (wasInside ? 'liquidar' : 'esgotar')
      : inLiveGrade(r) ? 'grade'
        : r.last_sale == null ? 'anuncio'
          : wasInside ? 'liquidar' : 'esgotar'

    byAction[action].skus += 1
    byAction[action].pieces += k.stock
    byAction[action].cost += k.cost

    items.push({ ...k, action, cumShare })
  }

  return {
    items,
    cost,
    pieces,
    share: stockCost > 0 ? cost / stockCost : 0,
    byAction,
  }
}
