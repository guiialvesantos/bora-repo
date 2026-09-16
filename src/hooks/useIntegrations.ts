import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { supabase } from '@/lib/supabase'
import { useCompany } from '@/contexts/CompanyContext'

export interface IntegrationConnection {
  id: string
  provider: string
  status: 'disconnected' | 'connected' | 'error'
  last_error: string | null
  settings: Record<string, unknown>
  connected_at: string | null
  /** Segmento da URL do webhook (`/tiny-webhook/<token>`). Não é segredo — só torna a URL não adivinhável. */
  webhook_token: string
}

export interface SyncRun {
  id: string
  kind: string
  status: 'running' | 'done' | 'paused' | 'error'
  resource: string | null
  cursor: string | null
  processed: number
  error: string | null
  started_at: string
  finished_at: string | null
}

/**
 * `.maybeSingle()` porque nunca existiu conexão é o estado normal antes do
 * primeiro `connect` — não é erro, é tela vazia.
 */
export function useIntegrationConnection(provider: 'tiny_v2' | 'tiny_v3' = 'tiny_v2') {
  const { companyId } = useCompany()

  return useQuery({
    queryKey: ['integration-connection', companyId, provider],
    enabled: !!companyId,
    refetchInterval: 10_000,
    queryFn: async (): Promise<IntegrationConnection | null> => {
      const { data, error } = await supabase
        .from('integration_connections')
        .select('id, provider, status, last_error, settings, connected_at, webhook_token')
        .eq('company_id', companyId!)
        .eq('provider', provider)
        .maybeSingle()
      if (error) throw error
      return data as IntegrationConnection | null
    },
  })
}

export function useSyncRuns(connectionId: string | null) {
  return useQuery({
    queryKey: ['sync-runs', connectionId],
    enabled: !!connectionId,
    refetchInterval: 5_000,
    queryFn: async (): Promise<SyncRun[]> => {
      const { data, error } = await supabase
        .from('sync_runs')
        .select('id, kind, status, resource, cursor, processed, error, started_at, finished_at')
        .eq('connection_id', connectionId!)
        .order('started_at', { ascending: false })
        .limit(5)
      if (error) throw error
      return (data ?? []) as SyncRun[]
    },
  })
}

interface TinyAction {
  action:
    | 'connect' | 'test' | 'disconnect' | 'settings' | 'sync_now'
    | 'oauth_init' | 'oauth_test' | 'oauth_disconnect'
  token?: string
  clientId?: string
  clientSecret?: string
  settings?: Record<string, unknown>
}

/**
 * Uma mutation só para as cinco ações: todas passam pela mesma Edge Function
 * (`tiny-connect`), que já decide o que fazer com `action`. Cinco hooks quase
 * idênticos duplicariam o `invalidateQueries` de cada um sem ganhar nada.
 */
export function useTinyConnect() {
  const { companyId } = useCompany()
  const queryClient = useQueryClient()

  return useMutation({
    mutationFn: async (body: TinyAction) => {
      const { data, error } = await supabase.functions.invoke('tiny-connect', {
        body: { ...body, companyId },
      })
      if (error) {
        // `error.message` do supabase-js é genérico ("Edge Function returned
        // a non-2xx status code") em qualquer erro HTTP — o motivo de verdade
        // (ex.: "token invalido") só vem no corpo da resposta, em `context`.
        const context = (error as { context?: Response }).context
        const body = await context?.json?.().catch(() => null)
        throw new Error(body?.error ? String(body.error) : error.message)
      }
      if (data?.error) throw new Error(String(data.error))
      return data
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['integration-connection', companyId] })
      queryClient.invalidateQueries({ queryKey: ['sync-runs'] })
      queryClient.invalidateQueries({ queryKey: ['data-health', companyId] })
    },
  })
}
