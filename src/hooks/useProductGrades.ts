import { useQuery } from '@tanstack/react-query'
import { supabase } from '@/lib/supabase'
import { fetchAllRows } from '@/lib/paging'
import { useCompany } from '@/contexts/CompanyContext'

interface GradeRow {
  id: string
  external_id: string | null
  sku: string | null
  name: string | null
  parent_external_id: string | null
}

export interface Grade {
  /** `products.id` do pai — ou do próprio produto, quando ele não tem pai. */
  id: string
  sku: string | null
  name: string | null
  /** Quantas variações o catálogo pendura nesse pai. 0 em produto avulso. */
  variations: number
}

export interface GradeIndex {
  /** product_id (qualquer) → a grade a que ele pertence. */
  groupOf: Map<string, Grade>
  /** Há pelo menos um pai com filho? Falso nas empresas em Tiny v2. */
  hasGrades: boolean
}

/**
 * Resolve cada produto à sua grade — o pai, quando existe.
 *
 * O vínculo vem de `parent_external_id`, que o worker copia de `produtoPai.id`
 * do ERP. Nunca do nome: o padrão "<pai> - <cor/tamanho>" erra nos dois
 * sentidos (deixa órfã variação com vínculo quebrado no Tiny e adota todo
 * produto avulso que tenha traço no nome), e um agrupamento adivinhado somaria
 * demanda de itens que não são a mesma peça.
 *
 * Pai ausente do catálogo → a variação é a própria grade, em vez de sumir.
 */
export function useProductGrades() {
  const { companyId } = useCompany()

  return useQuery({
    queryKey: ['product-grades', companyId],
    enabled: !!companyId,
    queryFn: async (): Promise<GradeIndex> => {
      const rows = await fetchAllRows<GradeRow>(() =>
        supabase
          .from('products')
          .select('id, external_id, sku, name, parent_external_id')
          .eq('company_id', companyId!)
          .order('id'))

      const byExternalId = new Map<string, GradeRow>()
      for (const r of rows) if (r.external_id) byExternalId.set(r.external_id, r)

      const grades = new Map<string, Grade>()
      const groupOf = new Map<string, Grade>()

      const gradeFor = (r: GradeRow): Grade => {
        const existing = grades.get(r.id)
        if (existing) return existing
        const g: Grade = { id: r.id, sku: r.sku, name: r.name, variations: 0 }
        grades.set(r.id, g)
        return g
      }

      for (const r of rows) {
        const parent = r.parent_external_id ? byExternalId.get(r.parent_external_id) : undefined
        const root = parent && parent.id !== r.id ? parent : r
        const g = gradeFor(root)
        if (root !== r) g.variations += 1
        groupOf.set(r.id, g)
      }

      let hasGrades = false
      for (const g of grades.values()) if (g.variations > 0) { hasGrades = true; break }

      return { groupOf, hasGrades }
    },
  })
}
