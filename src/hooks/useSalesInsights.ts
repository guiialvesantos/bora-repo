import { useQuery } from '@tanstack/react-query'
import { supabase } from '@/lib/supabase'
import { useCompany } from '@/contexts/CompanyContext'
import type { CensusFilters } from './useDashboardCensus'

/**
 * Os relatórios que saem da VENDA, não do estoque.
 *
 * Todos obedecem a canal e período e **nenhum** obedece a depósito: pedido não
 * tem depósito. A peça saiu da empresa; de qual prateleira foi tirada não está
 * no pedido e não mudaria o fato de que aquela cor vendeu. Por isso os hooks
 * daqui recebem os filtros e descartam `warehouseIds` — o descarte é explícito
 * para que ninguém "conserte" isso depois passando o array adiante.
 */

export type TopColors = {
  colors: { color: string; units: string; revenue: string }[]
  total_units: string
  total_revenue: string
  total_colors: number
  /** Falso na empresa sem variação (a Triana). Vazio por falta de dado ≠ por
   *  falta de venda, e a tela precisa saber qual dos dois está olhando. */
  has_variants: boolean
}

export function useTopColors(filters: CensusFilters, limit = 8) {
  const { companyId } = useCompany()

  return useQuery({
    queryKey: ['top-colors', companyId, filters.channel, filters.from, filters.to, limit],
    enabled: !!companyId,
    queryFn: async (): Promise<TopColors> => {
      const { data, error } = await supabase.rpc('dashboard_top_colors', {
        _company_id: companyId,
        _channel: filters.channel,
        _from: filters.from,
        _to: filters.to,
        _limit: limit,
      })
      if (error) throw error
      return data as TopColors
    },
  })
}

export type SalesByCategory = {
  categories: {
    name: string
    units: string
    revenue: string
    /** O resto do caminho, não a folha: "Upper → Casual" ≠ "Bottom → Casual". */
    children: { name: string; units: string; revenue: string }[]
  }[]
  total_units: string
  total_revenue: string
  /** Venda de produto sem categoria no catálogo. Fora do total de propósito:
   *  somar aqui dentro faria a soma fechar e mentir sobre a cobertura. */
  uncategorized_units: string
  uncategorized_revenue: string
  /** Falso na empresa cujo catálogo não categoriza nada (a Triana). */
  has_categories: boolean
}

export function useSalesByCategory(filters: CensusFilters) {
  const { companyId } = useCompany()

  return useQuery({
    queryKey: ['sales-by-category', companyId, filters.channel, filters.from, filters.to],
    enabled: !!companyId,
    queryFn: async (): Promise<SalesByCategory> => {
      const { data, error } = await supabase.rpc('dashboard_sales_by_category', {
        _company_id: companyId,
        _channel: filters.channel,
        _from: filters.from,
        _to: filters.to,
      })
      if (error) throw error
      return data as SalesByCategory
    },
  })
}

export type Basket = {
  orders: string
  pairs: { a_name: string; b_name: string; orders: string }[]
  pair_count: number
  upsell: {
    from_name: string
    to_name: string
    orders: string
    from_orders: string
    confidence: string
    lift: string
  }[]
  min_orders: number
}

/**
 * Cesta: o que sai junto e o que puxa o quê.
 *
 * Um RPC só para os dois cartões porque os dois saem da mesma varredura de
 * coocorrência — pedir duas vezes seria pagar duas vezes pelo mesmo cruzamento
 * para desenhar dois quadros lado a lado.
 */
export function useBasket(filters: CensusFilters, limit = 5) {
  const { companyId } = useCompany()

  return useQuery({
    queryKey: ['basket', companyId, filters.channel, filters.from, filters.to, limit],
    enabled: !!companyId,
    queryFn: async (): Promise<Basket> => {
      const { data, error } = await supabase.rpc('dashboard_basket', {
        _company_id: companyId,
        _channel: filters.channel,
        _from: filters.from,
        _to: filters.to,
        _limit: limit,
      })
      if (error) throw error
      return data as Basket
    },
  })
}
