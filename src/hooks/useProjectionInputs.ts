import { useQuery } from '@tanstack/react-query'
import { supabase } from '@/lib/supabase'
import { fetchAllRows } from '@/lib/paging'
import { useCompany } from '@/contexts/CompanyContext'

/** Reta: sete dias iguais. É o que sobra quando não há amostra para afirmar mais. */
const FLAT: number[] = [1, 1, 1, 1, 1, 1, 1]

export interface DemandProfile {
  /** Pesos por dia da semana (0 = domingo), média 1. */
  weights: number[]
  source: 'sales' | 'flat'
  spanDays: number
  units: number
}

/**
 * O ritmo semanal da demanda, medido da venda real.
 *
 * Serve só para desenhar: multiplicar a taxa diária por pesos de média 1 não
 * mexe em uma vírgula do total semanal — logo não mexe em ES, PP nem Emáx. O
 * que muda é a projeção deixar de afirmar que domingo e sexta vendem igual,
 * quando a base diz 0,48 contra 1,26.
 *
 * Degrada para reta em silêncio se a função ainda não existe no banco: uma
 * linha reta é exatamente o comportamento antigo, não um erro que valha
 * interromper o Painel.
 */
export function useDemandProfile() {
  const { companyId } = useCompany()

  return useQuery({
    queryKey: ['demand-profile', companyId],
    enabled: !!companyId,
    staleTime: 60 * 60 * 1000,
    queryFn: async (): Promise<DemandProfile> => {
      const { data, error } = await supabase.rpc('demand_daily_profile', {
        _company_id: companyId,
      })
      if (error) return { weights: FLAT, source: 'flat', spanDays: 0, units: 0 }

      const d = data as { weights?: unknown; source?: string; span_days?: number; units?: number }
      const w = Array.isArray(d?.weights) ? d.weights.map(Number) : []
      const usable = w.length === 7 && w.every((n) => Number.isFinite(n) && n > 0)

      return {
        weights: usable ? w : FLAT,
        source: usable && d.source === 'sales' ? 'sales' : 'flat',
        spanDays: Number(d?.span_days ?? 0),
        units: Number(d?.units ?? 0),
      }
    },
  })
}

interface TransitRow {
  product_id: string | null
  sku_norm: string | null
  qty_open: string | null
  eta_on: string | null
  /** O join embutido do PostgREST chega como lista, mesmo sendo 1:1. */
  purchase_orders: { eta_on: string | null }[] | null
}

export interface TransitLine {
  /** yyyy-mm-dd. Null quando o pedido não tem previsão — trata-se como "agora". */
  eta: string | null
  qty: number
}

export interface TransitIndex {
  byProduct: Map<string, TransitLine[]>
  bySku: Map<string, TransitLine[]>
  /** Quantas linhas abertas têm previsão. Zero = nada a escalonar. */
  withEta: number
}

/**
 * As compras já feitas e ainda não recebidas, com a data prevista.
 *
 * Sem isto a projeção empilha todo o em-trânsito no dia 0 — desenha como se a
 * carga já estivesse na prateleira. Com as datas, o estoque SOBE no dia em que
 * cada pedido chega, que é a única coisa capaz de fazer a linha subir.
 *
 * Casa por `product_id` e, quando o ERP não amarrou o produto (134 das 302
 * linhas hoje), por `sku_norm` — a mesma chave que o motor usa.
 */
export function useInTransitEta() {
  const { companyId } = useCompany()

  return useQuery({
    queryKey: ['transit-eta', companyId],
    enabled: !!companyId,
    queryFn: async (): Promise<TransitIndex> => {
      const rows = await fetchAllRows<TransitRow>(() =>
        supabase
          .from('purchase_order_items')
          .select('product_id, sku_norm, qty_open, eta_on, purchase_orders!inner(status, eta_on)')
          .eq('company_id', companyId!)
          .gt('qty_open', 0)
          .in('purchase_orders.status', ['open', 'draft'])
          .order('id'))

      const byProduct = new Map<string, TransitLine[]>()
      const bySku = new Map<string, TransitLine[]>()
      let withEta = 0

      for (const r of rows) {
        const qty = Number(r.qty_open ?? 0)
        if (!(qty > 0)) continue
        // A previsão da linha ganha da do pedido: um pedido pode vir em duas
        // remessas, e quando isso está gravado é informação melhor.
        const eta = r.eta_on ?? r.purchase_orders?.[0]?.eta_on ?? null
        if (eta) withEta += 1

        const line: TransitLine = { eta, qty }
        if (r.product_id) {
          const l = byProduct.get(r.product_id)
          if (l) l.push(line); else byProduct.set(r.product_id, [line])
        }
        if (r.sku_norm) {
          const l = bySku.get(r.sku_norm)
          if (l) l.push(line); else bySku.set(r.sku_norm, [line])
        }
      }

      return { byProduct, bySku, withEta }
    },
  })
}
