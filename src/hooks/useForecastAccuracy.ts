import { useQuery } from '@tanstack/react-query'
import { supabase } from '@/lib/supabase'
import { useCompany } from '@/contexts/CompanyContext'
import { fetchAllRows } from '@/lib/paging'
import type { ForecastAccuracy } from '@/lib/replenishment-types'

/**
 * Erro histórico do forecast por SKU, do modelo vivo. Recalculado toda semana
 * pelo cron `forecast-accuracy-weekly` — daqui só se lê.
 *
 * Devolve um Map por `sku_norm` porque quem consome (o chip XYZ) casa pelo SKU
 * normalizado do snapshot, e 400+ lookups por render pedem O(1).
 */
export function useForecastAccuracy() {
  const { companyId } = useCompany()

  return useQuery({
    queryKey: ['forecast-accuracy', companyId],
    enabled: !!companyId,
    queryFn: async (): Promise<Map<string, ForecastAccuracy>> => {
      const rows = await fetchAllRows<ForecastAccuracy>(() =>
        supabase
          .from('forecast_accuracy')
          .select('sku_norm, wmape, bias, origins_n')
          .eq('company_id', companyId!)
          .eq('model', 'weighted_90_180')
          .order('sku_norm', { ascending: true }))
      return new Map(rows.map((r) => [r.sku_norm, r]))
    },
  })
}
