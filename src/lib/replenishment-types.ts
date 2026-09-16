// Os tipos do motor. Espelham as colunas de `replenishment_snapshot_items` e o
// jsonb de `replenishment_snapshots.totals`.
//
// Tudo que é `numeric` no Postgres chega como **string** pelo PostgREST — é de
// propósito, porque `numeric` guarda mais precisão do que um `number` de JS
// aguenta. Converter na borda (`num()`) e nunca no meio do cálculo.

export type AbcClass = 'A' | 'B' | 'C'

export type RecentWindowAnchor = 'today' | 'reference_date'
export type ReferenceDateMode = 'max_sale_date' | 'today'
export type SigmaSource = 'computed' | 'external'
export type SkuMatchMode = 'exact' | 'normalized'
export type DemandModel = 'blended_legacy' | 'weighted_90_180'
export type SigmaAnchor = 'global_history_legacy' | 'sku_first_sale'
/**
 * Divisor das janelas de 90/180 dias: `fixed` usa sempre 13 e 26 semanas;
 * `effective` usa a idade do SKU quando ela é menor, para não contar como
 * venda zero semana em que o produto não existia.
 */
export type DemandWindowBasis = 'fixed' | 'effective'
/** Base do `E` do motor: saldo físico ou disponível para venda (saldo − reservas). */
export type StockBasis = 'saldo' | 'disponivel'

export type ImportKind = 'products' | 'sales' | 'in_transit' | 'discontinued' | 'sigma'

/** `numeric` do Postgres chega como string. Isto é a borda. */
export function num(v: string | number | null | undefined): number {
  if (v == null) return 0
  return typeof v === 'number' ? v : Number(v)
}

/** Como `num`, mas preserva o nulo — "não se aplica" não é zero. */
export function maybeNum(v: string | number | null | undefined): number | null {
  if (v == null) return null
  return typeof v === 'number' ? v : Number(v)
}

export interface ReplenishmentParams {
  id: string
  company_id: string
  version: number
  is_current: boolean

  lead_time_days: number
  order_cycle_weeks: string
  cmv_pct: string

  service_level_a: string
  service_level_b: string
  service_level_c: string

  abc_cut_a: string
  abc_cut_b: string

  recent_window_days: number

  recent_window_anchor: RecentWindowAnchor
  safety_stock_for_out_of_collection: boolean
  reference_date_mode: ReferenceDateMode
  sigma_source: SigmaSource
  sku_match_mode: SkuMatchMode
  demand_model: DemandModel
  demand_window_basis: DemandWindowBasis
  sigma_anchor: SigmaAnchor
  stock_basis: StockBasis

  /** Cortes de CV da classe XYZ, calibrados nos tercis da base da empresa. */
  xyz_cut_x: string
  xyz_cut_y: string

  today_override: string | null
  sales_cutoff_on: string | null

  note: string | null
  created_by: string | null
  created_at: string
}

/** Os sete agregados do `Variáveis`, cada um `[a preço de venda, a custo]`. */
export interface SnapshotTotals {
  current: [number, number]
  discontinued: [number, number]
  active: [number, number]
  safety: [number, number]
  average: [number, number]
  max_active: [number, number]
  max_with_discontinued: [number, number]
}

export interface Snapshot {
  id: string
  company_id: string
  params_id: string
  params_version: number

  reference_date: string
  today_effective: string
  global_first_sale_date: string | null
  history_weeks: number

  item_count: number
  in_collection: number
  abc_a: number
  abc_b: number
  abc_c: number
  order_lines: number
  order_pieces: string

  totals: SnapshotTotals
  note: string | null
  created_at: string

  /** Evidência histórica: com qual modelo de demanda este cálculo foi feito. */
  demand_model: string | null
  demand_model_version: number | null
}

/**
 * Erro histórico do forecast por SKU (tabela `forecast_accuracy`), medido no
 * backtest rolling do modelo vivo. `wmape` nulo = realizado somou zero em
 * todas as janelas — sem métrica honesta, a UI mostra "sem erro medido".
 */
export interface ForecastAccuracy {
  sku_norm: string
  wmape: string | null
  bias: string | null
  origins_n: number
}

export interface SnapshotItem {
  snapshot_id: string
  product_id: string
  sku: string | null
  name: string | null
  source_row: number | null

  stock_total: string
  sale_price: string
  cmv_raw: string | null
  cmv_suspect: boolean
  cmv_used: string

  first_sale_date: string | null
  weeks_in_catalog: string | null
  total_sales: string
  weekly_all: string
  weekly_recent: string
  weekly_blended: string
  weekly_revenue: string
  demand_90d_weekly: string | null
  demand_180d_weekly: string | null

  sigma: string
  sigma_weeks: number | null
  low_confidence: boolean

  abc_class: AbcClass | null
  abc_cum_pct: string | null
  z: string | null

  safety_stock: string | null
  reorder_point: string | null
  max_stock: string | null
  in_transit: string

  in_collection: boolean
  should_order: boolean
  qty_to_order: string
}

/** O que `replenishment_preview` devolve: agregados, sem as 600 linhas. */
export interface PreviewResult {
  totals: SnapshotTotals
  item_count: number
  in_collection: number
  abc_a: number
  abc_b: number
  abc_c: number
  order_lines: number
  order_pieces: string
  reference_date: string | null
  history_weeks: number | null
  low_confidence: number
}

export interface DataSourceHealth {
  kind: ImportKind
  provider: string | null
  filename: string | null
  row_count: number
  covers_until: string | null
  refreshed_at: string | null
  stale: boolean
  missing: boolean
}

export interface DataHealthReport {
  sources: DataSourceHealth[]
  checks: {
    sales_skus_without_product: number
    transit_items_without_product: number
    transit_qty_without_product: number
    transit_qty_lost_to_whitespace: number
    sales_overlapping_pairs: number
    sales_overlapping_qty: number
    orders_pending_items: number
    products_without_price: number
    recent_window_dead: boolean
  }
  params: {
    version: number
    demand_model: DemandModel
    recent_window_anchor: RecentWindowAnchor
    sku_match_mode: SkuMatchMode
    sigma_source: SigmaSource
    safety_stock_for_out_of_collection: boolean
  }
  /** O que impede de gerar pedido. Vazio = pode gerar. */
  blocking: string[]
}

export const KIND_LABEL: Record<ImportKind, string> = {
  products: 'Estoque e catálogo',
  sales: 'Vendas',
  in_transit: 'Em trânsito',
  discontinued: 'Fora de coleção',
  sigma: 'Desvio-padrão legado',
}
