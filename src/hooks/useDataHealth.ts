import { useQuery } from '@tanstack/react-query'
import { supabase } from '@/lib/supabase'
import { useCompany } from '@/contexts/CompanyContext'
import type { DataHealthReport } from '@/lib/replenishment-types'

/**
 * Porte da aba `Verificações`: uma linha por fonte de dado, mais os problemas
 * que a planilha não sabia ver (venda sem produto casado, pedido sem itens).
 */
export function useDataHealth() {
  const { companyId } = useCompany()

  return useQuery({
    queryKey: ['data-health', companyId],
    enabled: !!companyId,
    staleTime: 60_000,
    queryFn: async (): Promise<DataHealthReport> => {
      const { data, error } = await supabase.rpc('data_health_report', {
        _company_id: companyId,
      })
      if (error) throw error
      return data as DataHealthReport
    },
  })
}
