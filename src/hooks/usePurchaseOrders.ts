import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { supabase } from '@/lib/supabase'
import { useCompany } from '@/contexts/CompanyContext'

export type PurchaseStatus = 'draft' | 'open' | 'received' | 'cancelled'

export interface PurchaseOrderItemRow {
  id: string
  product_id: string | null
  sku: string | null
  qty_ordered: string
  qty_suggested: string | null
  qty_received: string
  qty_open: string
  unit_cost: string | null
}

export interface PurchaseOrderRow {
  id: string
  status: PurchaseStatus
  source: string
  external_id: string | null
  supplier: string | null
  ordered_on: string | null
  eta_on: string | null
  note: string | null
  params_version: number | null
  created_at: string
  purchase_order_items: PurchaseOrderItemRow[]
}

/**
 * Os pedidos gravados, com as linhas embutidas.
 *
 * Vem tudo de uma vez porque o que a tela mostra de cada pedido — peças, valor,
 * quanto ainda está em aberto — é agregado das linhas, e buscar por pedido
 * daria um N+1 numa lista que é curta por natureza (é compra, não venda).
 */
export function usePurchaseOrders() {
  const { companyId } = useCompany()

  return useQuery({
    queryKey: ['purchase-orders', companyId],
    enabled: !!companyId,
    queryFn: async (): Promise<PurchaseOrderRow[]> => {
      const { data, error } = await supabase
        .from('purchase_orders')
        .select('id, status, source, external_id, supplier, ordered_on, eta_on, note, '
          + 'params_version, created_at, purchase_order_items(id, product_id, sku, qty_ordered, '
          + 'qty_suggested, qty_received, qty_open, unit_cost)')
        .eq('company_id', companyId!)
        .order('created_at', { ascending: false })
        .limit(100)
      if (error) throw error
      return (data ?? []) as unknown as PurchaseOrderRow[]
    },
  })
}

export interface NewOrderLine { product_id: string; qty: number }

export function useCreatePurchaseOrder() {
  const { companyId } = useCompany()
  const qc = useQueryClient()

  return useMutation({
    mutationFn: async (v: {
      snapshotId: string
      lines: NewOrderLine[]
      supplier?: string
      note?: string
    }): Promise<string> => {
      const { data, error } = await supabase.rpc('purchase_order_create_from_snapshot', {
        _company_id: companyId,
        _snapshot_id: v.snapshotId,
        _lines: v.lines,
        _supplier: v.supplier ?? null,
        _eta_on: null,
        _note: v.note ?? null,
      })
      if (error) throw error
      return data as string
    },
    // O pedido nasce contando como trânsito, então a sugestão da próxima
    // rodada muda. Invalidar a saúde junto mantém o banner honesto.
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['purchase-orders'] })
      qc.invalidateQueries({ queryKey: ['data-health'] })
    },
  })
}

export function useUpdateOrderStatus() {
  const qc = useQueryClient()

  return useMutation({
    mutationFn: async (v: { id: string; status: PurchaseStatus }) => {
      const { error } = await supabase
        .from('purchase_orders')
        .update({ status: v.status })
        .eq('id', v.id)
      if (error) throw error
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['purchase-orders'] })
      qc.invalidateQueries({ queryKey: ['data-health'] })
    },
  })
}
