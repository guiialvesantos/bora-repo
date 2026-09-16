import { useQuery } from '@tanstack/react-query'
import { supabase } from '@/lib/supabase'
import { useCompany } from '@/contexts/CompanyContext'

/**
 * O recorte escolhido na barra de filtros do Painel.
 *
 * Depósito é LISTA porque quem tem loja física, CD e full de marketplace quase
 * nunca quer um só — quer "os meus dois, sem o full". Lista vazia significa o
 * padrão (os depósitos disponíveis para venda), não "nenhum depósito":
 * desmarcar o último item não pode zerar a tela inteira.
 */
export type CensusFilters = {
  warehouseIds: string[]
  channel: string | null
  from: string | null
  to: string | null
}

export type Census = {
  products: number
  in_collection: number
  with_stock: number
  pieces: number
  stock_cost: number
  stock_price: number
  out_of_stock: number
  below_safety: number
  sold_units: number
  sold_revenue: number
  orders: number
  order_lines: number
  channels: string[]
  has_snapshot: boolean
}

/**
 * O censo filtrável — consulta viva, não o snapshot.
 *
 * Existe separado de `useSnapshotItems` de propósito: o snapshot não guarda
 * depósito, canal nem mês, então esses três recortes não sairiam dele sem
 * inventar. Em troca, o censo não fala de ponto de pedido nem de estoque
 * máximo: essas contas continuam vindo do motor, sobre o agregado.
 *
 * Agrega no banco e devolve jsonb — 2.079 produtos × 10 depósitos são ~20 mil
 * linhas que não têm por que atravessar a rede para virar seis números.
 */
export function useDashboardCensus(filters: CensusFilters) {
  const { companyId } = useCompany()

  return useQuery({
    queryKey: ['dashboard-census', companyId, filters],
    enabled: !!companyId,
    queryFn: async (): Promise<Census> => {
      const { data, error } = await supabase.rpc('dashboard_census', {
        _company_id: companyId,
        _warehouse_ids: filters.warehouseIds.length ? filters.warehouseIds : null,
        _channel: filters.channel,
        _from: filters.from,
        _to: filters.to,
      })
      if (error) throw error
      return data as Census
    },
  })
}

/**
 * Saldo por produto nos depósitos escolhidos — o que falta para os números do
 * motor obedecerem ao filtro.
 *
 * Só consulta quando há escolha. Sem filtro, o `stock_total` que já está em
 * cada linha do snapshot é exatamente esta soma (o motor usa a mesma definição
 * de "disponível para venda"), e refazê-la traria de quebra um efeito ruim: o
 * saldo vivo mudou desde o cálculo, então a tela sem filtro passaria a
 * discordar de Pedido de compra sem ninguém ter pedido recorte nenhum.
 */
export function useStockByWarehouses(warehouseIds: string[]) {
  const { companyId } = useCompany()
  const enabled = !!companyId && warehouseIds.length > 0

  return useQuery({
    queryKey: ['stock-by-warehouse', companyId, warehouseIds],
    enabled,
    queryFn: async (): Promise<Map<string, number>> => {
      const { data, error } = await supabase.rpc('dashboard_stock_by_product', {
        _company_id: companyId,
        _warehouse_ids: warehouseIds,
      })
      if (error) throw error
      // Vem como objeto de `numeric`, que o PostgREST serializa em string.
      return new Map(
        Object.entries(data as Record<string, string | number>)
          .map(([id, qty]) => [id, Number(qty)]),
      )
    },
  })
}

/** Conexões da empresa — só para nomear a integração viva na barra de filtros. */
export function useConnections() {
  const { companyId } = useCompany()

  return useQuery({
    queryKey: ['connections', companyId],
    enabled: !!companyId,
    queryFn: async () => {
      const { data, error } = await supabase
        .from('integration_connections')
        .select('id, provider, status')
        .eq('company_id', companyId!)
      if (error) throw error
      return data
    },
  })
}

/** Depósitos da empresa, para o filtro. */
export function useWarehouses() {
  const { companyId } = useCompany()

  return useQuery({
    queryKey: ['warehouses', companyId],
    enabled: !!companyId,
    queryFn: async () => {
      const { data, error } = await supabase
        .from('warehouses')
        .select('id, name, include_in_available')
        .eq('company_id', companyId!)
        .order('name')
      if (error) throw error
      return data
    },
  })
}
