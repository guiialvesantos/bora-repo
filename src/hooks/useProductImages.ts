import { useQuery } from '@tanstack/react-query'
import { supabase } from '@/lib/supabase'
import { useCompany } from '@/contexts/CompanyContext'
import { fetchAllRows } from '@/lib/paging'

/**
 * Mapa `product_id → image_url` para as telas que leem do snapshot
 * (`replenishment_snapshot_items` não carrega a foto — ela é exibição,
 * não entra no cálculo, então mora só em `products`).
 */
export function useProductImages() {
  const { companyId } = useCompany()

  return useQuery({
    queryKey: ['product-images', companyId],
    enabled: !!companyId,
    staleTime: 5 * 60_000,
    queryFn: async () => {
      const rows = await fetchAllRows<{ id: string; image_url: string | null }>(() =>
        supabase.from('products')
          .select('id, image_url')
          .eq('company_id', companyId!)
          .order('id'))
      const map = new Map<string, string>()
      for (const r of rows) {
        if (r.image_url) map.set(r.id, r.image_url)
      }
      return map
    },
  })
}
