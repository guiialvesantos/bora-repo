import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { supabase } from '@/lib/supabase'
import { useCompany } from '@/contexts/CompanyContext'
import type { PreviewResult, ReplenishmentParams } from '@/lib/replenishment-types'

/** A versão corrente dos parâmetros. Nunca editada no lugar — ver 0005. */
export function useReplenishmentParams() {
  const { companyId } = useCompany()

  return useQuery({
    queryKey: ['replenishment-params', companyId],
    enabled: !!companyId,
    queryFn: async (): Promise<ReplenishmentParams | null> => {
      const { data, error } = await supabase
        .from('replenishment_params')
        .select('*')
        .eq('company_id', companyId!)
        .eq('is_current', true)
        .maybeSingle()
      if (error) throw error
      return data as ReplenishmentParams | null
    },
  })
}

/** O histórico completo. É o que dá contexto quando um pedido muda de tamanho. */
export function useParamsHistory() {
  const { companyId } = useCompany()

  return useQuery({
    queryKey: ['replenishment-params-history', companyId],
    enabled: !!companyId,
    queryFn: async (): Promise<ReplenishmentParams[]> => {
      const { data, error } = await supabase
        .from('replenishment_params')
        .select('*')
        .eq('company_id', companyId!)
        .order('version', { ascending: false })
      if (error) throw error
      return (data ?? []) as ReplenishmentParams[]
    },
  })
}

/**
 * Simula um patch sem gravar nada. É o que o formulário chama enquanto o
 * usuário mexe nos campos: devolve só os agregados, então pode rodar a cada
 * mudança sem encher o banco de snapshots descartáveis.
 */
export function usePreview() {
  const { companyId } = useCompany()

  return useMutation({
    mutationFn: async (overrides: Record<string, unknown>): Promise<PreviewResult> => {
      const { data, error } = await supabase.rpc('replenishment_preview', {
        _company_id: companyId,
        _overrides: overrides,
      })
      if (error) throw error
      return data as PreviewResult
    },
  })
}

/**
 * Publica uma versão nova e recalcula. As duas coisas andam juntas de
 * propósito: parâmetro publicado sem snapshot correspondente é um número na
 * tela que ninguém consegue explicar depois.
 */
export function usePublishParams() {
  const { companyId } = useCompany()
  const qc = useQueryClient()

  return useMutation({
    mutationFn: async ({ patch, note }: { patch: Record<string, unknown>; note?: string }) => {
      const { error } = await supabase.rpc('publish_replenishment_params', {
        _company_id: companyId,
        _patch: patch,
        _note: note ?? null,
      })
      if (error) throw error

      const { data: snapId, error: computeError } = await supabase.rpc('replenishment_compute', {
        _company_id: companyId,
        _note: note ?? 'Recalculado após mudança de parâmetros',
      })
      if (computeError) throw computeError
      return snapId as string
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['replenishment-params'] })
      qc.invalidateQueries({ queryKey: ['replenishment-params-history'] })
      qc.invalidateQueries({ queryKey: ['snapshot'] })
      qc.invalidateQueries({ queryKey: ['snapshot-items'] })
      qc.invalidateQueries({ queryKey: ['data-health'] })
    },
  })
}
