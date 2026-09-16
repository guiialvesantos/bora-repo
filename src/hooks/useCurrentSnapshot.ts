import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { supabase } from '@/lib/supabase'
import { useCompany } from '@/contexts/CompanyContext'
import { fetchAllRows } from '@/lib/paging'
import type { Snapshot, SnapshotItem } from '@/lib/replenishment-types'

/**
 * O snapshot mais recente da empresa.
 *
 * As quatro telas leem daqui — nenhuma recalcula por conta própria. É o que
 * impede o painel, a curva ABC e o pedido de compra de discordarem entre si
 * quando alguém importa um arquivo no meio da navegação.
 */
export function useCurrentSnapshot() {
  const { companyId } = useCompany()

  return useQuery({
    queryKey: ['snapshot', companyId],
    enabled: !!companyId,
    queryFn: async (): Promise<Snapshot | null> => {
      const { data, error } = await supabase
        .from('replenishment_snapshots')
        .select('*')
        .eq('company_id', companyId!)
        .order('created_at', { ascending: false })
        .limit(1)
        .maybeSingle()
      if (error) throw error
      return data as Snapshot | null
    },
  })
}

/**
 * As linhas do snapshot, paginadas.
 *
 * `fetchAllRows` não é zelo excessivo: o PostgREST corta em 1000 linhas **sem
 * avisar**, e 600 SKUs hoje já é perto demais desse teto. A tabela truncada
 * pareceria completa.
 */
export function useSnapshotItems(snapshotId: string | null | undefined) {
  return useQuery({
    queryKey: ['snapshot-items', snapshotId],
    enabled: !!snapshotId,
    queryFn: async (): Promise<SnapshotItem[]> =>
      fetchAllRows<SnapshotItem>(() =>
        supabase
          .from('replenishment_snapshot_items')
          .select('*')
          .eq('snapshot_id', snapshotId!)
          .order('sku', { ascending: true })),
  })
}

/** Recalcula com os parâmetros correntes e grava um snapshot novo. */
export function useComputeSnapshot() {
  const { companyId } = useCompany()
  const qc = useQueryClient()

  return useMutation({
    mutationFn: async (note?: string): Promise<string> => {
      const { data, error } = await supabase.rpc('replenishment_compute', {
        _company_id: companyId,
        _note: note ?? null,
      })
      if (error) throw error
      return data as string
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['snapshot'] })
      qc.invalidateQueries({ queryKey: ['snapshot-items'] })
    },
  })
}
