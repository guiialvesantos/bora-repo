import { useQuery } from '@tanstack/react-query'
import { supabase } from '@/lib/supabase'
import { fetchAllRows } from '@/lib/paging'
import { useCompany } from '@/contexts/CompanyContext'

/**
 * A ficha de um produto só — uma consulta para a tela inteira (0032).
 *
 * Seis consultas separadas fariam a tela piscar em pedaços a cada troca de
 * produto no seletor, cada painel chegando na sua hora. Como a tela existe
 * justamente para trocar de produto, o custo da troca é o custo da tela.
 */

export interface ProductAnalysisData {
  today: string
  from: string
  days: number
  product: {
    id: string
    sku: string | null
    name: string | null
    image_url: string | null
    sale_price: string | null
    cmv: string | null
    category: string | null
    brand: string | null
    tags: string[] | null
    is_active: boolean
    variation_type: string | null
    parent_id: string | null
    parent_name: string | null
    created_at: string
  }
  /** Os números abaixo são de um CONJUNTO (a grade inteira), não de um SKU. */
  is_grade: boolean
  /** Quantos produtos entram na conta: 1 numa variação, N num pai. */
  scope_size: number
  stock: string
  /** Somado peça a peça com o preço de cada variação — um preço médio vezes o
   *  saldo total erraria em toda grade que mistura tamanho caro e barato. */
  stock_value: string
  stock_cost: string
  warehouses: { name: string; qty: string; available: boolean }[]
  in_transit: string
  /** Só os dias COM venda. A série com os zeros é montada na tela. */
  daily: { d: string; u: string; r: string }[]
  windows: {
    days: number
    units: string
    revenue: string
    days_with_sale: number
    /** Quantos dias da janela o produto existiu para vender. */
    effective_days: number
  }[]
  siblings: { id: string; sku: string | null; name: string | null; stock: string; units: string }[]
  first_sale: string | null
  last_sale: string | null
  total_units: string
  total_revenue: string
  /**
   * A venda semana a semana desde a PRIMEIRA venda, a vida inteira do produto —
   * não obedece ao seletor de período, porque a pergunta é "como foi o
   * lançamento", e um lançamento não cabe numa janela de 30 dias.
   *
   * Ancorado no INÍCIO (o contrário dos baldes do gráfico de histórico): semana
   * 1 tem que ser a semana 1. Por isso a INCOMPLETA é a ÚLTIMA, e ela vem com
   * `days` < 7 para a tela não desenhar uma queda que não houve.
   */
  launch: { week: number; units: string; revenue: string; days: number }[]
  /** A primeira venda cai nos 7 primeiros dias da base: a curva começa onde
   *  começam os DADOS, não onde começou o produto. 14,5% do catálogo da All Out. */
  launch_censored: boolean
  base_start: string | null
  /**
   * Quando entrou mercadoria e quanto (0039). Não vem de nota fiscal — não
   * existe nota de entrada na base —, e sim do degrau no saldo diário mais a
   * venda do intervalo. `span` é quantos dias o degrau cobre: 1 no normal, 2+
   * quando o snapshot da noite falhou e a data vira um intervalo.
   */
  entries: { d: string; q: string; span: number }[]
  /** Primeiro dia com foto de saldo. Antes disso não há como saber — e silêncio
   *  aqui não significa "não entrou nada". */
  entries_since: string | null
  last_entry: string | null
  entries_total: string
}

export function useProductAnalysis(productId: string | undefined, days: number) {
  const { companyId } = useCompany()

  return useQuery({
    queryKey: ['product-analysis', companyId, productId, days],
    enabled: !!companyId && !!productId,
    queryFn: async (): Promise<ProductAnalysisData> => {
      const { data, error } = await supabase.rpc('product_analysis', {
        _company_id: companyId,
        _product_id: productId,
        _days: days,
      })
      if (error) throw error
      return data as ProductAnalysisData
    },
  })
}

export interface PickerProduct {
  id: string
  sku: string | null
  name: string | null
  image_url: string | null
  is_active: boolean
  variation_type: string | null
}

/**
 * A lista do seletor. Carrega o catálogo inteiro uma vez — 2 mil linhas de
 * cinco campos — em vez de consultar o banco a cada tecla: a busca por
 * digitação tem que responder no quadro seguinte, e uma ida ao servidor por
 * letra devolve resultado fora de ordem quando a rede treme.
 *
 * Pai e variação estão os DOIS aqui, desde a 0034. Antes o pai ficava de fora
 * porque a ficha dele vinha vazia; agora ele soma a grade, que é justamente a
 * pergunta de quem compra — compra-se a grade, não o tamanho M. A variação
 * continua na lista porque quem procura por SKU procura pelo SKU que existe no
 * ERP, e esse é o da variação.
 *
 * Quem separa os dois na tela é a ORDEM (grades primeiro) e o rótulo, não um
 * filtro: filtrar obrigaria a busca a adivinhar qual dos dois o usuário quer.
 */
export function useProductPicker() {
  const { companyId } = useCompany()

  return useQuery({
    queryKey: ['product-picker', companyId],
    enabled: !!companyId,
    staleTime: 5 * 60_000,
    queryFn: async (): Promise<PickerProduct[]> =>
      fetchAllRows<PickerProduct>(() =>
        supabase
          .from('products')
          .select('id, sku, name, image_url, is_active, variation_type')
          .eq('company_id', companyId!)
          .order('sku', { ascending: true, nullsFirst: false })
          .order('id')),
  })
}
