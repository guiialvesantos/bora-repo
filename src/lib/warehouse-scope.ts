import { num } from './replenishment-types'
import type { SnapshotItem, SnapshotTotals } from './replenishment-types'

/**
 * Reancora as linhas do cálculo nos depósitos escolhidos na barra de filtros.
 *
 * O snapshot é uma foto agregada: o `stock_total` que ele guarda é a soma dos
 * depósitos marcados como disponíveis para venda (CTE `base` da 0007). Quando
 * alguém recorta a tela para dois depósitos, esse número deixa de descrever o
 * que está na tela — e com ele saem de sincronia o capital parado, a cobertura,
 * a projeção e as duas barras, que são todos derivados dele.
 *
 * O que se faz aqui NÃO é recalcular o motor. `safety_stock`, `reorder_point` e
 * `max_stock` são política da empresa e não têm versão por depósito: ficam
 * intactos. Troca-se o saldo e refaz-se, sobre a própria linha, a única
 * aritmética que dependia dele — a mesma expressão, letra por letra, que está
 * no `select` final de `replenishment_calc`:
 *
 *     should_order  = in_collection and stock + trânsito <= ponto de pedido
 *     qty_to_order  = máximo − stock − trânsito, quando pede
 *
 * Duplicar duas linhas de conta é o preço de não ter uma dimensão de depósito
 * dentro do snapshot. Se um dia o motor ganhar essa dimensão, este arquivo
 * morre inteiro.
 *
 * O em-trânsito NÃO é recortado: a compra chega para a empresa, e o depósito de
 * destino só é conhecido quando alguém dá entrada. Repartir por rateio seria
 * inventar.
 */
export function scopeToWarehouses(
  items: SnapshotItem[],
  stockByProduct: Map<string, number>,
): SnapshotItem[] {
  return items.map((i) => {
    const stock = stockByProduct.get(i.product_id) ?? 0
    if (stock === num(i.stock_total)) return i

    const position = stock + num(i.in_transit)
    const rp = i.reorder_point == null ? null : num(i.reorder_point)
    const shouldOrder = i.in_collection && rp != null && position <= rp
    const qty = shouldOrder && i.max_stock != null
      ? Math.max(0, num(i.max_stock) - position)
      : 0

    return {
      ...i,
      stock_total: String(stock),
      should_order: shouldOrder,
      qty_to_order: String(qty),
    }
  })
}

/**
 * Os sete agregados a partir das linhas — porte de `replenishment_totals`.
 *
 * Existe só para o recorte por depósito: sem filtro, quem manda é o
 * `snapshot.totals`, que veio do banco. Com filtro, o `totals` do snapshot
 * descreve outro conjunto de depósitos e precisa ser refeito sobre as linhas
 * reancoradas.
 *
 * `safety` e `max_active` não dependem de saldo — só de política e preço — e
 * portanto saem iguais aos do snapshot, o que é a prova de que a conta está
 * certa.
 */
export function totalsOf(items: SnapshotItem[]): SnapshotTotals {
  let curPrice = 0, curCost = 0
  let discPrice = 0, discCost = 0
  let actPrice = 0, actCost = 0
  let safPrice = 0, safCost = 0
  let maxPrice = 0, maxCost = 0

  for (const i of items) {
    const stock = num(i.stock_total)
    const price = num(i.sale_price)
    const cost = num(i.cmv_used)

    curPrice += stock * price
    curCost += stock * cost
    if (i.in_collection) {
      actPrice += stock * price
      actCost += stock * cost
      maxPrice += num(i.max_stock) * price
      maxCost += num(i.max_stock) * cost
    } else {
      discPrice += stock * price
      discCost += stock * cost
    }
    // O de segurança soma TODO mundo, inclusive fora de coleção: é o que a
    // planilha faz e o que o motor reproduz (`sum(t_safety * …)` sem filtro).
    safPrice += num(i.safety_stock) * price
    safCost += num(i.safety_stock) * cost
  }

  return {
    current: [curPrice, curCost],
    discontinued: [discPrice, discCost],
    active: [actPrice, actCost],
    safety: [safPrice, safCost],
    max_active: [maxPrice, maxCost],
    average: [(maxPrice + safPrice) / 2, (maxCost + safCost) / 2],
    max_with_discontinued: [maxPrice + discPrice, maxCost + discCost],
  }
}
