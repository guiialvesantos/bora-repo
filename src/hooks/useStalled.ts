import { useQuery } from '@tanstack/react-query'
import { supabase } from '@/lib/supabase'
import { useCompany } from '@/contexts/CompanyContext'

/** Uma linha de estoque que parou de sair. Numéricos chegam como texto. */
export interface StalledRow {
  id: string
  sku: string | null
  name: string | null
  image_url: string | null
  is_active: boolean
  variation_type: string | null
  parent_id: string | null
  parent_name: string | null
  category: string | null
  tags: string[] | null
  stock: string
  cmv: string
  cost: string
  first_sale: string | null
  last_sale: string | null
  /** Dias desde a última venda. `null` = nunca vendeu — que não é zero. */
  days: number | null
  total_units: string
  units_90: string
  /** Marcado à mão como fora de coleção. Separado de "nunca vendeu" de propósito. */
  discontinued: boolean
  /** Tamanho da grade a que pertence (0 = produto avulso). */
  grade_size: number
  /** Quantos irmãos da grade ainda venderam nos últimos 90 dias. */
  grade_alive: number
}

export interface StalledData {
  reference_date: string
  base_start: string | null
  min_days: number
  /** Denominador: o estoque inteiro com saldo, parado ou não. */
  stock_cost: string
  stock_pieces: string
  stock_skus: number
  rows: StalledRow[]
}

/**
 * O corte de dias é feito NO BANCO em 30 e refinado no cliente.
 *
 * Trazer tudo acima de 30 dias uma vez só deixa o seletor de janela (30/60/90/
 * 180/365) responder no quadro seguinte, sem uma ida ao servidor por clique —
 * e são as mesmas linhas, só que menos delas. Abaixo de 30 a lista deixaria de
 * ser de encalhados: quinze dias sem vender é fim de semana comprido.
 */
export function useStalled() {
  const { companyId } = useCompany()

  return useQuery({
    queryKey: ['stalled', companyId],
    enabled: !!companyId,
    staleTime: 60_000,
    queryFn: async (): Promise<StalledData> => {
      const { data, error } = await supabase.rpc('dashboard_stalled', {
        _company_id: companyId,
        _min_days: 30,
      })
      if (error) throw error
      return data as StalledData
    },
  })
}
