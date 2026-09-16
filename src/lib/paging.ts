/**
 * PostgREST corta a resposta em `max-rows` (1000 por padrão no Supabase) sem avisar:
 * a query volta com 1000 linhas e status 200. Qualquer leitura que possa passar
 * disso tem que vir por aqui.
 */
export const PAGE_SIZE = 1000

/**
 * Só o que de fato usamos do builder do PostgREST.
 *
 * Tipar pelo `PostgrestFilterBuilder` de verdade obrigaria a repetir os oito
 * parâmetros genéricos dele em cada chamada — e esses genéricos mudam entre
 * versões da lib, então a assinatura quebraria numa atualização de patch. Uma
 * interface estrutural com o único método que importa sobrevive a isso.
 */
interface Pageable<Row> {
  range(from: number, to: number): PromiseLike<{ data: Row[] | null; error: unknown }>
}

export async function fetchAllRows<Row>(
  build: () => Pageable<Row>,
  pageSize = PAGE_SIZE,
): Promise<Row[]> {
  const out: Row[] = []
  for (let from = 0; ; from += pageSize) {
    const { data, error } = await build().range(from, from + pageSize - 1)
    if (error) throw error
    const page = data ?? []
    out.push(...page)
    if (page.length < pageSize) return out
  }
}
