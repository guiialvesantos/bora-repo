import { maybeNum, num } from './replenishment-types'
import type { SnapshotItem } from './replenishment-types'

/**
 * Capital parado: quanto do dinheiro que já saiu do caixa está em estoque que
 * não vai girar — e por qual motivo, porque cada motivo tem uma saída
 * diferente (liquidar, promover, ou só parar de comprar).
 *
 * Tudo aqui é A CUSTO (`cmv_used`), não a preço de venda. Capital parado é
 * dinheiro desembolsado; medir a preço de venda infla o problema com uma
 * margem que ninguém realizou.
 *
 * As faixas são exclusivas e avaliadas nesta ordem — um item fora de coleção
 * com estoque acima do Emáx conta uma vez só, na causa mais grave:
 *
 *   1. fora de coleção  — não será recomprado; só sai vendendo ou liquidando
 *   2. sem giro         — demanda semanal zero; cobertura infinita
 *   3. excesso          — a parte ACIMA do Emáx de um item que gira normal
 *   4. saudável         — o resto
 *
 * Só (3) é parcial: divide o mesmo SKU entre saudável e excesso, porque é
 * literalmente isso que acontece — as primeiras N peças têm destino, as de
 * cima não.
 */

export type IdleBucketKey = 'healthy' | 'excess' | 'stale' | 'discontinued'

export const IDLE_BUCKETS: {
  key: IdleBucketKey
  label: string
  hint: string
  /**
   * Classe de preenchimento — rampa de gravidade lida do próprio ramp da marca:
   * verde claro (sadio) → verde âncora (sobrou) → cinza escuro (parado) →
   * vermelho (morto). Os dois primeiros passos são do mesmo verde de propósito,
   * porque as duas faixas ainda são dinheiro que gira; o cinza é o que saiu de
   * circulação e o vermelho o que não volta.
   */
  fill: string
}[] = [
  { key: 'healthy', label: 'Estoque saudável', hint: 'gira e cabe na política', fill: 'bg-brand-400' },
  { key: 'excess', label: 'Acima do estoque máximo', hint: 'gira, mas sobrou', fill: 'bg-brand-600' },
  { key: 'stale', label: 'Sem giro', hint: 'demanda semanal zero', fill: 'bg-mono-700' },
  { key: 'discontinued', label: 'Fora de coleção', hint: 'não será recomprado', fill: 'bg-error-600' },
]

export interface IdleSlice {
  key: IdleBucketKey
  cost: number
  pieces: number
  skus: number
}

export interface IdleOffender {
  productId: string
  sku: string
  name: string
  bucket: IdleBucketKey
  pieces: number
  cost: number
  /** Semanas de estoque ao ritmo atual. `null` = sem giro (não acaba nunca). */
  coverageWeeks: number | null
}

export interface IdleCapitalReport {
  slices: IdleSlice[]
  offenders: IdleOffender[]
  totalCost: number
  idleCost: number
  idlePieces: number
  /** Fração do capital em estoque que está parado, 0–1. */
  idleShare: number
}

export function analyseIdleCapital(items: SnapshotItem[], topN = 8): IdleCapitalReport {
  const slices: Record<IdleBucketKey, IdleSlice> = {
    healthy: { key: 'healthy', cost: 0, pieces: 0, skus: 0 },
    excess: { key: 'excess', cost: 0, pieces: 0, skus: 0 },
    stale: { key: 'stale', cost: 0, pieces: 0, skus: 0 },
    discontinued: { key: 'discontinued', cost: 0, pieces: 0, skus: 0 },
  }
  const offenders: IdleOffender[] = []

  for (const i of items) {
    const stock = num(i.stock_total)
    if (stock <= 0) continue

    const unit = num(i.cmv_used)
    const weekly = num(i.weekly_blended)
    const coverageWeeks = weekly > 0 ? stock / weekly : null

    const add = (key: IdleBucketKey, pieces: number) => {
      if (pieces <= 0) return
      slices[key].cost += pieces * unit
      slices[key].pieces += pieces
      slices[key].skus += 1
      if (key !== 'healthy') {
        offenders.push({
          productId: i.product_id,
          sku: i.sku ?? '—',
          name: i.name ?? '',
          bucket: key,
          pieces,
          cost: pieces * unit,
          coverageWeeks,
        })
      }
    }

    if (!i.in_collection) {
      add('discontinued', stock)
    } else if (weekly <= 0) {
      add('stale', stock)
    } else {
      // `max_stock` nulo em item em coleção não deveria existir; se existir,
      // tratar como sem excesso é mais honesto do que chamar tudo de sobra.
      const max = maybeNum(i.max_stock)
      const excess = max == null ? 0 : Math.max(0, stock - max)
      add('excess', excess)
      add('healthy', stock - excess)
    }
  }

  const list = IDLE_BUCKETS.map((b) => slices[b.key])
  const totalCost = list.reduce((s, x) => s + x.cost, 0)
  const idleCost = totalCost - slices.healthy.cost
  const idlePieces = slices.excess.pieces + slices.stale.pieces + slices.discontinued.pieces

  return {
    slices: list,
    offenders: offenders.sort((a, b) => b.cost - a.cost).slice(0, topN),
    totalCost,
    idleCost,
    idlePieces,
    idleShare: totalCost > 0 ? idleCost / totalCost : 0,
  }
}
