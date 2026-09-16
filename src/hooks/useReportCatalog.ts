import { useQuery } from '@tanstack/react-query'
import { supabase } from '@/lib/supabase'
import { useCompany } from '@/contexts/CompanyContext'

/**
 * Uma linha do catálogo INTEIRO — inclusive o que zerou. Numéricos chegam como
 * texto. `sell_through` é nulo só quando o SKU nunca vendeu e não tem saldo.
 */
export interface ReportCatalogRow {
  id: string
  sku: string | null
  name: string | null
  category: string | null
  tags: string[] | null
  is_active: boolean
  variation_type: string | null
  parent_name: string | null
  discontinued: boolean
  stock: string
  sale_price: string
  cmv: string
  cost: string
  price_value: string
  first_sale: string | null
  last_sale: string | null
  days: number | null
  units_total: string
  units_90: string
  sell_through: string | null
}

export interface ReportCatalogData {
  reference_date: string
  base_start: string | null
  /** Totais do que TEM saldo — o denominador de qualquer percentual impresso. */
  stock_cost: string
  stock_price: string
  stock_pieces: string
  stock_skus: number
  /** Inclui o que esgotou: é maior que `stock_skus`, e essa é a razão da RPC. */
  catalog_skus: number
  rows: ReportCatalogRow[]
}

/**
 * Diferente das outras telas, esta NÃO pode filtrar saldo zero no banco.
 *
 * Sell-through de 100% é o produto que esgotou; um `having sum(qty) > 0`
 * apagaria exatamente a resposta que o relatório procura. Por isso vem o
 * catálogo inteiro — ~2 mil linhas na All Out — e quem quer só a prateleira
 * (Posição de estoque) filtra aqui no cliente.
 */
export function useReportCatalog(enabled = true) {
  const { companyId } = useCompany()

  return useQuery({
    queryKey: ['report-catalog', companyId],
    enabled: !!companyId && enabled,
    staleTime: 60_000,
    queryFn: async (): Promise<ReportCatalogData> => {
      const { data, error } = await supabase.rpc('report_catalog', {
        _company_id: companyId,
      })
      if (error) throw error
      return data as ReportCatalogData
    },
  })
}
