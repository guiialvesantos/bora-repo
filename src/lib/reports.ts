import { num, maybeNum } from './replenishment-types'
import { ACTION_BY_KEY } from './stalled'
import type { StalledItem } from './stalled'
import type { ReportCatalogRow, ReportCatalogData } from '@/hooks/useReportCatalog'
import type { SnapshotItem } from './replenishment-types'

/**
 * Relatório é consulta congelada, não tela.
 *
 * A diferença não é cosmética. Uma tela responde "como está agora" e pode mudar
 * de ideia a cada sync. Um relatório sai da impressora, vai para a reunião e é
 * cobrado três semanas depois — então ele precisa dizer, no próprio corpo, de
 * que data ele fala e com que régua foi feito. Por isso todo relatório aqui
 * carrega `reference_date` e uma linha de procedência, e nenhum deles usa
 * `current_date`: a âncora é a última venda da empresa, igual ao resto do
 * sistema. Um sync parado não pode envelhecer um documento assinado.
 *
 * O desenho segue o mesmo contrato do resto: a RPC devolve FATO, este arquivo
 * aplica POLÍTICA. Trocar o corte de sell-through ou a ordem das colunas não
 * encosta no banco.
 */

export type ReportKey = 'sell-through' | 'pedido' | 'posicao' | 'encalhados'

export interface ReportDef {
  key: ReportKey
  title: string
  /** A pergunta que ele responde, em uma linha. */
  question: string
  /** De onde vêm as linhas — decide qual hook a página precisa acordar. */
  source: 'catalog' | 'snapshot' | 'stalled'
}

export const REPORTS: ReportDef[] = [
  {
    key: 'sell-through',
    title: 'Sell-through',
    question: 'O que gira: quanto de tudo que entrou já saiu, por SKU.',
    source: 'catalog',
  },
  {
    key: 'pedido',
    title: 'Pedido de compra',
    question: 'O que comprar nesta rodada, com custo e total — para mandar ao fornecedor.',
    source: 'snapshot',
  },
  {
    key: 'posicao',
    title: 'Posição de estoque',
    question: 'Quanto existe e quanto vale, a custo e a preço de venda.',
    source: 'catalog',
  },
  {
    key: 'encalhados',
    title: 'Encalhados',
    question: 'O que parou de sair, há quanto tempo e o que fazer com cada um.',
    source: 'stalled',
  },
]

export const REPORT_BY_KEY = Object.fromEntries(
  REPORTS.map((r) => [r.key, r]),
) as Record<ReportKey, ReportDef>

export type CellFormat = 'text' | 'mono' | 'int' | 'brl' | 'pct' | 'date'

export interface ReportColumn {
  key: string
  label: string
  format: CellFormat
}

export type ReportCell = string | number | null

export interface ReportTable {
  columns: ReportColumn[]
  rows: Record<string, ReportCell>[]
  /** Linha de total, quando somar faz sentido (dinheiro e peças). */
  total?: Record<string, ReportCell>
  /** Números de topo — o que alguém lê antes da tabela. */
  summary: { label: string; value: string }[]
  /** Blocos auxiliares impressos antes da tabela (ex.: por categoria). */
  breakdown?: { title: string; rows: { label: string; value: string }[] }
  /** Texto curto abaixo do título, explicando o recorte. */
  caption: string
  empty: string
}

export interface ReportParams {
  /** Sell-through mínimo, em pontos percentuais (80 = 80%). */
  minPct: number
  /** Piso de volume: sem ele, vender 2 peças e zerar vira "100%". */
  minUnits: number
  /** Dias sem vender, para Encalhados. */
  minDays: number
  /** `all` ou o nome da categoria. */
  category: string
  /** Posição de estoque: incluir o que está inativo no ERP. */
  includeInactive: boolean
}

export const DEFAULT_PARAMS: ReportParams = {
  minPct: 80,
  minUnits: 5,
  minDays: 90,
  category: 'all',
  includeInactive: false,
}

const ALL = 'all'

function pct(v: number) {
  return `${(v * 100).toLocaleString('pt-BR', {
    minimumFractionDigits: 1, maximumFractionDigits: 1,
  })}%`
}

function inCategory(row: { category: string | null }, category: string) {
  if (category === ALL) return true
  return (row.category ?? 'Sem categoria') === category
}

/** Categorias presentes, para alimentar o seletor. */
export function categoriesOf(rows: { category: string | null }[]): string[] {
  const set = new Set<string>()
  for (const r of rows) set.add(r.category ?? 'Sem categoria')
  return [...set].sort((a, b) => a.localeCompare(b, 'pt-BR'))
}

// ---------------------------------------------------------------------------

/**
 * Sell-through = vendidas ÷ (vendidas + em estoque).
 *
 * Os dois termos são contados, não estimados — o número é exato. O que ele NÃO
 * carrega é tamanho: 2 peças vendidas com saldo zero dão os mesmos 100% de 300.
 * Daí `minUnits` ser parâmetro de primeira classe e `units_total` ir impresso
 * ao lado do percentual, para a linha se defender sozinha.
 */
export function buildSellThrough(
  data: ReportCatalogData,
  p: ReportParams,
): ReportTable {
  const cut = p.minPct / 100
  const kept = data.rows
    .filter((r) => {
      const st = maybeNum(r.sell_through)
      return st != null && st >= cut
        && num(r.units_total) >= p.minUnits
        && inCategory(r, p.category)
    })
    .sort((a, b) => {
      const d = num(b.sell_through) - num(a.sell_through)
      return d !== 0 ? d : num(b.units_total) - num(a.units_total)
    })

  const sold = kept.reduce((s, r) => s + num(r.units_total), 0)
  // Saldo negativo entra como ZERO no total, mas segue cru na linha. A linha é
  // um fato sobre o cadastro — saiu mais do que o sistema achava que tinha, e
  // ver isso é útil. O total é contagem de peça em prateleira, e prateleira não
  // guarda quantidade negativa. Sem o piso, o recorte de 100% (justamente o dos
  // esgotados) imprimia "ainda em estoque: -5".
  const left = kept.reduce((s, r) => s + Math.max(num(r.stock), 0), 0)
  const zeroed = kept.filter((r) => num(r.stock) <= 0).length

  return {
    caption: `Sell-through de ${p.minPct}% ou mais, com pelo menos `
      + `${p.minUnits} ${p.minUnits === 1 ? 'peça vendida' : 'peças vendidas'}`
      + (p.category === ALL ? '' : ` · categoria ${p.category}`),
    summary: [
      { label: 'SKUs', value: kept.length.toLocaleString('pt-BR') },
      // Pelo MESMO formatador da coluna. A Triana vende fração (banho de peças
      // é cobrado a granel), e somando cru o resumo imprimia "5.494,32 peças"
      // ao lado de uma coluna de inteiros — a mesma quantidade com duas caras
      // no mesmo papel.
      { label: 'Peças vendidas', value: formatCell(sold, 'int') },
      { label: 'Ainda em estoque', value: formatCell(left, 'int') },
      { label: 'Já esgotados', value: zeroed.toLocaleString('pt-BR') },
    ],
    columns: [
      { key: 'sku', label: 'SKU', format: 'mono' },
      { key: 'name', label: 'Produto', format: 'text' },
      { key: 'category', label: 'Categoria', format: 'text' },
      { key: 'units', label: 'Vendidas', format: 'int' },
      { key: 'stock', label: 'Em estoque', format: 'int' },
      { key: 'st', label: 'Sell-through', format: 'pct' },
      { key: 'first', label: '1ª venda', format: 'date' },
      { key: 'cost', label: 'Capital parado', format: 'brl' },
    ],
    rows: kept.map((r) => ({
      sku: r.sku ?? '—',
      name: r.name ?? '—',
      category: r.category ?? 'Sem categoria',
      units: num(r.units_total),
      stock: num(r.stock),
      st: num(r.sell_through),
      first: r.first_sale,
      cost: num(r.cost),
    })),
    empty: 'Nenhum SKU passa desse corte. Tente baixar o percentual ou o mínimo de peças.',
  }
}

/**
 * Posição de estoque: só o que TEM prateleira.
 *
 * Aqui o filtro de saldo volta — um inventário não lista o que não existe. É o
 * mesmo `include_in_available` do motor, então o total fecha com o Painel e com
 * o Pedido de compra.
 */
export function buildPosicao(
  data: ReportCatalogData,
  p: ReportParams,
): ReportTable {
  const kept = data.rows
    .filter((r) => num(r.stock) > 0
      && (p.includeInactive || r.is_active)
      && inCategory(r, p.category))
    .sort((a, b) => {
      const ca = (a.category ?? 'Sem categoria').localeCompare(b.category ?? 'Sem categoria', 'pt-BR')
      return ca !== 0 ? ca : num(b.cost) - num(a.cost)
    })

  const pieces = kept.reduce((s, r) => s + num(r.stock), 0)
  const cost = kept.reduce((s, r) => s + num(r.cost), 0)
  const price = kept.reduce((s, r) => s + num(r.price_value), 0)

  // Subtotal por categoria vai num bloco à parte, não em linhas intercaladas:
  // intercalar quebra a ordenação da tabela quando alguém exporta ou reordena.
  const byCat = new Map<string, { pieces: number; cost: number }>()
  for (const r of kept) {
    const k = r.category ?? 'Sem categoria'
    const cur = byCat.get(k) ?? { pieces: 0, cost: 0 }
    cur.pieces += num(r.stock)
    cur.cost += num(r.cost)
    byCat.set(k, cur)
  }

  return {
    caption: 'Estoque com saldo nos depósitos que contam como disponível'
      + (p.includeInactive ? ', inclusive itens inativos no ERP' : '')
      + (p.category === ALL ? '' : ` · categoria ${p.category}`),
    summary: [
      { label: 'SKUs', value: kept.length.toLocaleString('pt-BR') },
      { label: 'Peças', value: formatCell(pieces, 'int') },
      { label: 'A custo', value: formatMoney(cost) },
      { label: 'A preço de venda', value: formatMoney(price) },
    ],
    breakdown: byCat.size > 1 ? {
      title: 'Por categoria',
      rows: [...byCat.entries()]
        .sort((a, b) => b[1].cost - a[1].cost)
        .map(([k, v]) => ({
          label: k,
          value: `${formatCell(v.pieces, 'int')} peças · ${formatMoney(v.cost)}`,
        })),
    } : undefined,
    columns: [
      { key: 'sku', label: 'SKU', format: 'mono' },
      { key: 'name', label: 'Produto', format: 'text' },
      { key: 'category', label: 'Categoria', format: 'text' },
      { key: 'stock', label: 'Peças', format: 'int' },
      { key: 'cmv', label: 'Custo un.', format: 'brl' },
      { key: 'cost', label: 'Custo total', format: 'brl' },
      { key: 'price', label: 'Preço un.', format: 'brl' },
      { key: 'value', label: 'A preço', format: 'brl' },
    ],
    rows: kept.map((r) => ({
      sku: r.sku ?? '—',
      name: r.name ?? '—',
      category: r.category ?? 'Sem categoria',
      stock: num(r.stock),
      cmv: num(r.cmv),
      cost: num(r.cost),
      price: num(r.sale_price),
      value: num(r.price_value),
    })),
    total: {
      sku: 'Total', name: '', category: '',
      stock: pieces, cmv: null, cost, price: null, value: price,
    },
    empty: 'Nenhum item com saldo neste recorte.',
  }
}

/** O pedido: as linhas que o motor mandou comprar, com custo e total. */
export function buildPedido(items: SnapshotItem[]): ReportTable {
  const kept = items
    .filter((i) => i.should_order)
    .sort((a, b) =>
      num(b.qty_to_order) * num(b.cmv_used) - num(a.qty_to_order) * num(a.cmv_used))

  const pieces = kept.reduce((s, i) => s + num(i.qty_to_order), 0)
  const cost = kept.reduce((s, i) => s + num(i.qty_to_order) * num(i.cmv_used), 0)

  return {
    caption: 'Itens em coleção cujo estoque mais o que está a caminho já caiu ao ponto de pedido',
    summary: [
      { label: 'Linhas', value: kept.length.toLocaleString('pt-BR') },
      { label: 'Peças', value: formatCell(pieces, 'int') },
      { label: 'Custo total', value: formatMoney(cost) },
    ],
    columns: [
      { key: 'sku', label: 'SKU', format: 'mono' },
      { key: 'name', label: 'Produto', format: 'text' },
      { key: 'stock', label: 'Estoque', format: 'int' },
      { key: 'transit', label: 'Trânsito', format: 'int' },
      { key: 'pp', label: 'PP', format: 'int' },
      { key: 'emax', label: 'Emáx', format: 'int' },
      { key: 'qty', label: 'Qtd a pedir', format: 'int' },
      { key: 'cmv', label: 'Custo un.', format: 'brl' },
      { key: 'line', label: 'Custo da linha', format: 'brl' },
    ],
    rows: kept.map((i) => ({
      sku: i.sku ?? '—',
      name: i.name ?? '—',
      stock: num(i.stock_total),
      transit: num(i.in_transit),
      pp: num(i.reorder_point),
      emax: num(i.max_stock),
      qty: num(i.qty_to_order),
      cmv: num(i.cmv_used),
      line: num(i.qty_to_order) * num(i.cmv_used),
    })),
    total: {
      sku: 'Total', name: '', stock: null, transit: null, pp: null, emax: null,
      qty: pieces, cmv: null, line: cost,
    },
    empty: 'Nada a pedir nesta rodada.',
  }
}

/** Encalhados: reusa a política já escrita em `stalled.ts`, sem recalcular. */
export function buildEncalhados(
  items: StalledItem[],
  p: ReportParams,
  stockCost: number,
): ReportTable {
  const kept = p.category === ALL
    ? items
    : items.filter((x) => (x.row.category ?? 'Sem categoria') === p.category)

  const cost = kept.reduce((s, x) => s + x.cost, 0)
  const pieces = kept.reduce((s, x) => s + x.stock, 0)

  return {
    caption: `Sem vender há mais de ${p.minDays} dias`
      + (p.category === ALL ? '' : ` · categoria ${p.category}`),
    summary: [
      { label: 'SKUs', value: kept.length.toLocaleString('pt-BR') },
      { label: 'Peças', value: formatCell(pieces, 'int') },
      { label: 'Capital parado', value: formatMoney(cost) },
      {
        label: 'Do estoque a custo',
        value: stockCost > 0 ? pct(cost / stockCost) : '—',
      },
    ],
    columns: [
      { key: 'sku', label: 'SKU', format: 'mono' },
      { key: 'name', label: 'Produto', format: 'text' },
      { key: 'last', label: 'Última venda', format: 'date' },
      { key: 'days', label: 'Dias parado', format: 'int' },
      { key: 'stock', label: 'Peças', format: 'int' },
      { key: 'cost', label: 'Capital', format: 'brl' },
      { key: 'action', label: 'Recomendação', format: 'text' },
    ],
    rows: kept.map((x) => ({
      sku: x.row.sku ?? '—',
      name: x.row.name ?? '—',
      last: x.row.last_sale,
      // Nulo, não zero: zero diria "vendeu hoje".
      days: x.days,
      stock: x.stock,
      cost: x.cost,
      action: ACTION_BY_KEY[x.action].label,
    })),
    total: {
      sku: 'Total', name: '', last: null, days: null,
      stock: pieces, cost, action: '',
    },
    empty: 'Nenhum item parado nesse recorte.',
  }
}

function formatMoney(v: number) {
  return v.toLocaleString('pt-BR', {
    style: 'currency', currency: 'BRL',
    minimumFractionDigits: 2, maximumFractionDigits: 2,
  })
}

/** Formata uma célula para a tela e para o papel — os dois leem o mesmo. */
export function formatCell(v: ReportCell, format: CellFormat): string {
  if (v == null || v === '') return '—'
  switch (format) {
    case 'int':
      return typeof v === 'number' ? Math.round(v).toLocaleString('pt-BR') : String(v)
    case 'brl':
      return typeof v === 'number' ? formatMoney(v) : String(v)
    case 'pct':
      return typeof v === 'number' ? pct(v) : String(v)
    case 'date':
      // Meio-dia porque `date` puro vira UTC e retrocede um dia em São Paulo.
      return typeof v === 'string'
        ? new Date(`${v}T12:00:00`).toLocaleDateString('pt-BR')
        : String(v)
    default:
      return String(v)
  }
}

export function isNumeric(format: CellFormat) {
  return format === 'int' || format === 'brl' || format === 'pct'
}

/** CSV com `;` e vírgula decimal: o que o Excel em pt-BR abre sem perguntar. */
export function reportToCsv(t: ReportTable): string {
  const esc = (s: string) => (/[;"\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s)
  const cell = (v: ReportCell, f: CellFormat) => {
    if (v == null) return ''
    // Número vai cru (com vírgula decimal) para o Excel poder somar; formatado
    // com "R$" ele viraria texto e a planilha não fecharia conta nenhuma.
    //
    // Cada formato leva as casas que o próprio número tem: peça é inteira e
    // sair "204,00" faz a coluna de unidades parecer dinheiro; e a fração vai
    // multiplicada por 100 porque o papel imprime "99,0%" — arquivo e folha
    // são o MESMO relatório, e quem confere um contra o outro não pode
    // encontrar "0,99" de um lado e "99,0%" do outro e achar que o dado mudou.
    if (typeof v === 'number' && isNumeric(f)) {
      if (f === 'int') return String(Math.round(v))
      if (f === 'pct') return (v * 100).toFixed(1).replace('.', ',')
      return v.toFixed(2).replace('.', ',')
    }
    return esc(formatCell(v, f))
  }
  const lines = [
    t.columns.map((c) => esc(c.label)).join(';'),
    ...t.rows.map((r) => t.columns.map((c) => cell(r[c.key], c.format)).join(';')),
  ]
  if (t.total) {
    lines.push('')
    lines.push(t.columns.map((c) => cell(t.total![c.key], c.format)).join(';'))
  }
  return lines.join('\r\n')
}

export type { ReportCatalogRow }
