import { Fragment, useMemo, useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { Link } from 'react-router-dom'
import { toast } from 'sonner'
import { ChevronDown, ChevronRight } from 'lucide-react'
import { supabase } from '@/lib/supabase'
import { useAuth } from '@/contexts/AuthContext'
import { useCompany } from '@/contexts/CompanyContext'
import { useReplenishmentParams } from '@/hooks/useReplenishmentParams'
import { useCurrentSnapshot, useSnapshotItems } from '@/hooks/useCurrentSnapshot'
import { fetchAllRows } from '@/lib/paging'
import { formatBRL, formatInt } from '@/lib/money'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { Checkbox } from '@/components/ui/checkbox'
import { Input } from '@/components/ui/input'
import {
  Select, SelectContent, SelectItem, SelectTrigger, SelectValue,
} from '@/components/ui/select'
import { Switch } from '@/components/ui/switch'
import {
  Table, TableBody, TableCell, TableHead, TableHeader, TableRow,
} from '@/components/ui/table'
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs'
import { ProductCell } from '@/components/ProductThumb'
import { ColLabel } from '@/components/InfoHint'

/**
 * A tela que tira a planilha de descontinuados do circuito: marcar/desmarcar
 * fora de coleção vira um switch aqui, escrito direto em `discontinued_items`
 * com `source = 'manual'` — que o importador preserva.
 *
 * O casamento produto ↔ marcação segue `sku_match_mode` dos parâmetros, o
 * MESMO critério do motor: no modo legado ('exact') compara `upper(sku)` sem
 * trim; no corrigido, `upper(btrim(sku))`. Usar outro critério aqui faria o
 * badge da tela discordar do `in_collection` do snapshot.
 */

interface ProductRow {
  id: string
  external_id: string | null
  sku: string | null
  name: string | null
  sale_price: string | null
  cmv: string | null
  is_active: boolean
  image_url: string | null
  tags: string[]
  category: string | null
  brand: string | null
  /** `external_id` do pai, já com o prefixo "tiny-". Só na v3. */
  parent_external_id: string | null
  /** 'N' normal · 'P' pai · 'V' variação. NULL nas empresas em v2. */
  variation_type: string | null
}

interface DiscRow {
  sku: string
  sku_norm: string | null
  sku_upper: string | null
  name: string | null
  source: 'import' | 'manual'
}

interface StockRow { product_id: string; qty: string | null }
interface TransitRow { sku_norm: string | null; qty_open: string | null }

function matchKey(sku: string | null, mode: string | undefined): string | null {
  if (!sku) return null
  const key = mode === 'exact' ? sku.toUpperCase() : sku.trim().toUpperCase()
  return key === '' ? null : key
}

function useCatalog() {
  const { companyId } = useCompany()
  return useQuery({
    queryKey: ['catalog', companyId],
    enabled: !!companyId,
    queryFn: async () => {
      const [products, stock, transit, disc] = await Promise.all([
        fetchAllRows<ProductRow>(() =>
          supabase.from('products')
            .select('id, external_id, sku, name, sale_price, cmv, is_active, image_url, tags, category, brand, parent_external_id, variation_type')
            .eq('company_id', companyId!)
            .order('sku', { ascending: true, nullsFirst: false })
            .order('id')),
        fetchAllRows<StockRow>(() =>
          supabase.from('product_stock')
            .select('product_id, qty')
            .eq('company_id', companyId!)
            .order('product_id')),
        fetchAllRows<TransitRow>(() =>
          supabase.from('purchase_order_items')
            .select('sku_norm, qty_open, purchase_orders!inner(status)')
            .eq('company_id', companyId!)
            .in('purchase_orders.status', ['open', 'draft'])
            .order('id')),
        fetchAllRows<DiscRow>(() =>
          supabase.from('discontinued_items')
            .select('sku, sku_norm, sku_upper, name, source')
            .eq('company_id', companyId!)
            .order('sku')),
      ])
      return { products, stock, transit, disc }
    },
  })
}

const n = (v: string | null | undefined) => (v == null ? 0 : Number(v))

/**
 * Demanda é fracionária: 0,4/sem e 0 são decisões diferentes. E uma casa
 * decimal transforma 0,04 em "0" — que ao lado do "—" de demanda zero vira
 * duas coisas diferentes escritas igual. Abaixo de 0,05 diz que é pouco, não
 * que é nada.
 */
const fmtWeekly = (v: number) => {
  if (v === 0) return '—'
  if (v < 0.05) return '< 0,1'
  return v.toLocaleString('pt-BR', { maximumFractionDigits: 1 })
}

/**
 * Preço da grade. Uma bermuda pode ter tamanhos a preços diferentes, então
 * exibir o preço do SKU do pai seria uma afirmação sobre os filhos que ninguém
 * conferiu. Quando divergem, mostra a faixa.
 */
function priceRange(values: number[]): string {
  const vals = values.filter((v) => v > 0)
  if (vals.length === 0) return '—'
  const min = Math.min(...vals)
  const max = Math.max(...vals)
  // Um "R$" só: repetir o símbolo estourava a coluna e jogava a faixa para
  // três linhas, que é pior do que a informação que ela carrega.
  return min === max
    ? formatBRL(min)
    : `${formatBRL(min)}–${max.toLocaleString('pt-BR', { minimumFractionDigits: 2 })}`
}

/**
 * Só de exibição, e só quando o nome do filho de fato começa pelo do pai. O
 * agrupamento em si nunca olha para o nome — ele vem do `produtoPai` do ERP.
 */
function shortName(name: string | null, parentName?: string | null): string | null {
  if (!name || !parentName || name === parentName) return name
  const rest = name.startsWith(parentName) ? name.slice(parentName.length) : null
  if (rest == null) return name
  const trimmed = rest.replace(/^[\s-]+/, '').trim()
  return trimmed === '' ? name : trimmed
}

type Filter = 'all' | 'in' | 'out' | 'stocked'

/**
 * As tags de governança de portfólio da All Out (cadastradas no Tiny):
 * core = reposição contínua · drop = lançar e acabar (em avaliação) ·
 * exit = saindo do portfólio. Qualquer outra tag aparece em cinza.
 */
const TAG_STYLE: Record<string, string> = {
  core: 'border-brand-300 bg-brand-100 text-brand-700',
  drop: 'border-cyan-300 bg-cyan-100 text-cyan-900',
  exit: 'border-error-300 bg-error-100 text-error-800',
}

function TagBadges({ tags }: { tags: string[] }) {
  if (tags.length === 0) return <span className="text-muted-foreground">—</span>
  return (
    <div className="flex flex-wrap gap-1">
      {tags.map((t) => (
        <Badge
          key={t}
          variant="outline"
          className={TAG_STYLE[t] ?? 'text-muted-foreground'}
        >
          {t}
        </Badge>
      ))}
    </div>
  )
}

export default function Products() {
  const { user } = useAuth()
  const { companyId } = useCompany()
  const { data: params } = useReplenishmentParams()
  const { data, isLoading } = useCatalog()
  // A demanda vem do MESMO snapshot que o pedido de compra lê. Recalcular aqui
  // faria esta tela discordar daquela — que é o defeito que o snapshot existe
  // para evitar.
  const { data: snapshot } = useCurrentSnapshot()
  const { data: snapItems } = useSnapshotItems(snapshot?.id)
  const qc = useQueryClient()

  const [search, setSearch] = useState('')
  const [filter, setFilter] = useState<Filter>('all')
  const [tagFilter, setTagFilter] = useState<string>('all')
  const [selected, setSelected] = useState<Set<string>>(new Set())
  const [grouped, setGrouped] = useState(true)
  const [open, setOpen] = useState<Set<string>>(new Set())

  const mode = params?.sku_match_mode
  const discCol = mode === 'exact' ? 'sku_upper' : 'sku_norm'

  const rows = useMemo(() => {
    if (!data) return []
    const stockByProduct = new Map<string, number>()
    for (const s of data.stock) {
      stockByProduct.set(s.product_id, (stockByProduct.get(s.product_id) ?? 0) + n(s.qty))
    }
    const transitByKey = new Map<string, number>()
    for (const t of data.transit) {
      if (!t.sku_norm) continue
      transitByKey.set(t.sku_norm, (transitByKey.get(t.sku_norm) ?? 0) + n(t.qty_open))
    }
    const discByKey = new Map<string, DiscRow>()
    for (const d of data.disc) {
      const key = mode === 'exact' ? d.sku_upper : d.sku_norm
      if (key) discByKey.set(key, d)
    }
    const snapByProduct = new Map(snapItems?.map((i) => [i.product_id, i]) ?? [])
    return data.products.map((p) => {
      const key = matchKey(p.sku, mode)
      const norm = p.sku ? p.sku.trim().toUpperCase() : null
      const disc = key ? discByKey.get(key) : undefined
      const snap = snapByProduct.get(p.id)
      return {
        ...p,
        key,
        stock: stockByProduct.get(p.id) ?? 0,
        transit: norm ? (transitByKey.get(norm) ?? 0) : 0,
        discontinued: !!disc,
        discSource: disc?.source,
        weekly: n(snap?.weekly_blended),
        toOrder: n(snap?.qty_to_order),
      }
    })
  }, [data, mode, snapItems])

  type Row = (typeof rows)[number]

  // Toda tag distinta que existe no catálogo, com core/drop/exit na frente.
  const allTags = useMemo(() => {
    const seen = new Set<string>()
    for (const r of rows) for (const t of r.tags) seen.add(t)
    const priority = ['core', 'drop', 'exit']
    return [
      ...priority.filter((t) => seen.has(t)),
      ...[...seen].filter((t) => !priority.includes(t)).sort(),
    ]
  }, [rows])

  const filtered = useMemo(() => {
    const q = search.trim().toUpperCase()
    return rows.filter((r) => {
      if (q && !(r.sku ?? '').toUpperCase().includes(q)
        && !(r.name ?? '').toUpperCase().includes(q)
        && !(r.category ?? '').toUpperCase().includes(q)) return false
      if (tagFilter === 'none' && r.tags.length > 0) return false
      if (tagFilter !== 'all' && tagFilter !== 'none' && !r.tags.includes(tagFilter)) return false
      if (filter === 'in') return !r.discontinued
      if (filter === 'out') return r.discontinued
      if (filter === 'stocked') return r.stock > 0
      return true
    })
  }, [rows, search, filter, tagFilter])

  /**
   * O vínculo pai ↔ variação vem do ERP (`produtoPai.id`), nunca do nome.
   * O padrão "<nome do pai> - <cor/tamanho>" casa 1.749 de 1.780 na All Out e
   * erra nos dois sentidos: deixa órfãs 25 variações cujo vínculo está quebrado
   * no próprio Tiny, e transforma em filho todo produto avulso com traço no
   * nome. Um agrupamento adivinhado somaria demanda errada sem avisar.
   */
  const byExternalId = useMemo(() => {
    const m = new Map<string, Row>()
    for (const r of rows) if (r.external_id) m.set(r.external_id, r)
    return m
  }, [rows])

  const childrenOf = useMemo(() => {
    const m = new Map<string, Row[]>()
    for (const r of rows) {
      if (!r.parent_external_id) continue
      const parent = byExternalId.get(r.parent_external_id)
      // Pai fora do catálogo: a variação vira linha solta em vez de sumir.
      if (!parent || parent.id === r.id) continue
      const list = m.get(parent.id)
      if (list) list.push(r)
      else m.set(parent.id, [r])
    }
    return m
  }, [rows, byExternalId])

  const hasGrades = childrenOf.size > 0

  /**
   * Variações que o Tiny marca como 'V' mas não aponta pai nenhum. São 25 na
   * All Out (o "Top Feminino … MPRun"). Aparecem soltas e rotuladas: o vínculo
   * está quebrado no ERP, e o lugar de consertar é lá.
   */
  const orphanCount = useMemo(() => rows.filter((r) =>
    r.variation_type === 'V'
    && !(r.parent_external_id && byExternalId.has(r.parent_external_id))).length,
  [rows, byExternalId])

  const useGroups = grouped && hasGrades

  const groups = useMemo(() => {
    if (!useGroups) return null
    const pass = new Set(filtered.map((r) => r.id))
    const isChild = new Set<string>()
    for (const list of childrenOf.values()) for (const c of list) isChild.add(c.id)

    const out = []
    for (const r of rows) {
      if (isChild.has(r.id)) continue
      const kids = childrenOf.get(r.id) ?? []
      // Membros da grade = o SKU do pai + as variações. O pai é um produto de
      // verdade no Tiny e pode ter estoque próprio (75 dos 299 têm) — deixá-lo
      // de fora faria a soma da linha discordar do estoque real do produto.
      const all = [r, ...kids]
      // Só entra na soma o que está listado: filtro aplicado, o total da linha
      // e as linhas abertas debaixo dela continuam falando do mesmo conjunto.
      const members = all.filter((m) => pass.has(m.id))
      if (members.length === 0) continue
      out.push({
        parent: r,
        isGrade: kids.length > 0,
        members,
        // O SKU do pai só se mostra quando carrega algo: repetir o nome do pai
        // numa linha de zeros não informa nada e esconde as variações.
        showSelf: pass.has(r.id)
          && (r.stock !== 0 || r.transit !== 0 || r.weekly !== 0
            || r.toOrder !== 0 || r.discontinued),
        agg: members.reduce((a, m) => ({
          stock: a.stock + m.stock,
          transit: a.transit + m.transit,
          weekly: a.weekly + m.weekly,
          toOrder: a.toOrder + m.toOrder,
        }), { stock: 0, transit: 0, weekly: 0, toOrder: 0 }),
        outOf: members.filter((m) => m.discontinued).length,
      })
    }
    return out
  }, [useGroups, filtered, rows, childrenOf])

  // Códigos que não casam com produto nenhum: são a cauda da planilha legada
  // (SKUs de coleções antigas que nem existem mais no catálogo). Não afetam o
  // cálculo — o motor só olha marcação que casa com produto — mas poluem a
  // contagem e um dia colidem com um SKU reutilizado.
  const legacy = useMemo(() => {
    if (!data) return []
    const productKeys = new Set(
      data.products.map((p) => matchKey(p.sku, mode)).filter((k): k is string => k != null),
    )
    return data.disc.filter((d) => {
      const key = mode === 'exact' ? d.sku_upper : d.sku_norm
      return !key || !productKeys.has(key)
    })
  }, [data, mode])

  const invalidate = () => {
    qc.invalidateQueries({ queryKey: ['catalog'] })
    qc.invalidateQueries({ queryKey: ['data-health'] })
  }

  const afterChange = (msg: string) => {
    invalidate()
    setSelected(new Set())
    toast.success(msg, {
      description: 'A mudança só entra nos números quando você recalcular no Painel.',
    })
  }

  const mark = useMutation({
    mutationFn: async (targets: typeof rows) => {
      const payload = targets
        .filter((r) => r.sku && !r.discontinued)
        .map((r) => ({
          company_id: companyId,
          sku: r.sku!,
          name: r.name,
          source: 'manual',
          created_by: user?.id ?? null,
        }))
      if (payload.length === 0) return 0
      const { error } = await supabase.from('discontinued_items')
        .upsert(payload, { onConflict: 'company_id,sku', ignoreDuplicates: true })
      if (error) throw error
      return payload.length
    },
    onSuccess: (count) => afterChange(`${formatInt(count)} produto(s) marcados como fora de coleção.`),
    onError: (e) => toast.error(e instanceof Error ? e.message : 'Falha ao marcar.'),
  })

  const unmark = useMutation({
    mutationFn: async (targets: typeof rows) => {
      const keys = targets.filter((r) => r.discontinued && r.key).map((r) => r.key!)
      if (keys.length === 0) return 0
      const { error } = await supabase.from('discontinued_items')
        .delete()
        .eq('company_id', companyId!)
        .in(discCol, keys)
      if (error) throw error
      return keys.length
    },
    onSuccess: (count) => afterChange(`${formatInt(count)} produto(s) de volta à coleção.`),
    onError: (e) => toast.error(e instanceof Error ? e.message : 'Falha ao desmarcar.'),
  })

  const removeLegacy = useMutation({
    mutationFn: async (skus: string[]) => {
      const { error } = await supabase.from('discontinued_items')
        .delete()
        .eq('company_id', companyId!)
        .in('sku', skus)
      if (error) throw error
      return skus.length
    },
    onSuccess: (count) => {
      invalidate()
      toast.success(`${formatInt(count)} código(s) legado(s) removidos.`)
    },
    onError: (e) => toast.error(e instanceof Error ? e.message : 'Falha ao remover.'),
  })

  const busy = mark.isPending || unmark.isPending

  const toggleOne = (r: (typeof rows)[number], next: boolean) => {
    if (busy) return
    if (next) mark.mutate([r])
    else unmark.mutate([r])
  }

  const selectedRows = filtered.filter((r) => selected.has(r.id))
  const allSelected = filtered.length > 0 && filtered.every((r) => selected.has(r.id))

  const outCount = rows.filter((r) => r.discontinued).length

  const toggleSelection = (ids: string[], on: boolean) => {
    const next = new Set(selected)
    for (const id of ids) {
      if (on) next.add(id)
      else next.delete(id)
    }
    setSelected(next)
  }

  const toggleOpen = (id: string) => {
    const next = new Set(open)
    if (next.has(id)) next.delete(id)
    else next.add(id)
    setOpen(next)
  }

  /**
   * A linha de um SKU concreto — a mesma na lista plana e dentro da grade.
   * `stripPrefix` corta o nome do pai repetido em cada variação: dentro de uma
   * grade aberta, "Calça Legging Racer 5 Bolsos - PP - Azul petróleo" 25 vezes
   * esconde a única coisa que distingue as linhas. Só corta quando o nome
   * realmente começa pelo do pai; o nome inteiro fica no `title`.
   */
  const leafRow = (r: Row, nested: boolean, selfOfGrade = false, stripPrefix?: string | null) => (
    <TableRow
      key={r.id}
      className={[
        r.discontinued ? 'opacity-70' : '',
        nested ? 'bg-surface-inset/30' : '',
      ].filter(Boolean).join(' ') || undefined}
    >
      {useGroups && (
        // Fio contínuo ligando as variações ao pai: sem ele, 25 linhas
        // recuadas viram um bloco solto quando a linha do pai rola para fora.
        <TableCell className="relative w-9 p-0">
          {nested && <div className="absolute inset-y-0 left-4 w-px bg-border" />}
        </TableCell>
      )}
      <TableCell>
        <Checkbox
          checked={selected.has(r.id)}
          onCheckedChange={(c) => toggleSelection([r.id], !!c)}
        />
      </TableCell>
      <TableCell className="font-mono text-xs">
        {r.sku ?? '—'}
      </TableCell>
      <TableCell className="w-[340px] max-w-[340px]" title={r.name ?? undefined}>
        <div className="flex min-w-0 items-center gap-2">
          {/* O nome é o link, não a linha inteira: a linha já tem checkbox e
              switch, e clique em linha aqui roubaria os dois. */}
          <Link
            to={`/analise/produto/${r.id}`}
            className="min-w-0 flex-1 rounded-xs hover:text-brand-600 hover:underline"
          >
            <ProductCell image={r.image_url} name={shortName(r.name, stripPrefix)} />
          </Link>
          {selfOfGrade && (
            <Badge variant="outline" className="shrink-0 text-muted-foreground">
              SKU do pai
            </Badge>
          )}
        </div>
      </TableCell>
      <TableCell><TagBadges tags={r.tags} /></TableCell>
      <TableCell className="max-w-[150px]">
        {r.category ? (
          <span className="block truncate text-xs text-muted-foreground" title={r.category}>
            {/* só o nó folha do caminho "Pai -> Filho" */}
            {r.category.split('->').pop()!.trim()}
          </span>
        ) : '—'}
      </TableCell>
      <TableCell className="text-right tabular-nums">{formatInt(r.stock)}</TableCell>
      <TableCell className="text-right tabular-nums">
        {r.transit > 0 ? formatInt(r.transit) : '—'}
      </TableCell>
      <TableCell className="text-right tabular-nums">
        {snapItems ? fmtWeekly(r.weekly) : '·'}
      </TableCell>
      <TableCell className="text-right tabular-nums">
        {snapItems ? (r.toOrder > 0 ? formatInt(r.toOrder) : '—') : '·'}
      </TableCell>
      <TableCell className="text-right tabular-nums">{formatBRL(n(r.sale_price))}</TableCell>
      <TableCell className="text-right tabular-nums">
        {r.cmv != null ? formatBRL(n(r.cmv)) : '—'}
      </TableCell>
      <TableCell>
        <div className="flex flex-wrap items-center gap-1.5">
          {r.is_active ? (
            <Badge variant="outline" className="border-success-300 bg-success-100 text-success-800">
              Ativo
            </Badge>
          ) : (
            <Badge variant="outline" className="border-error-300 bg-error-100 text-error-800">
              Inativo
            </Badge>
          )}
          {r.discontinued && (
            <Badge variant="outline" className="border-warning-300 bg-warning-200 text-warning-800">
              {r.discSource === 'manual' ? 'Fora · manual' : 'Fora · planilha'}
            </Badge>
          )}
          {r.variation_type === 'V'
            && !(r.parent_external_id && byExternalId.has(r.parent_external_id)) && (
            <Badge
              variant="outline"
              className="border-warning-300 bg-warning-200 text-warning-800"
              title="O Tiny marca este item como variação mas não aponta produto pai. O vínculo está quebrado no ERP — corrigir lá religa o agrupamento aqui."
            >
              Sem pai no Tiny
            </Badge>
          )}
        </div>
      </TableCell>
      <TableCell className="text-center">
        <Switch
          checked={r.discontinued}
          disabled={busy || !r.sku}
          onCheckedChange={(c) => toggleOne(r, c)}
        />
      </TableCell>
    </TableRow>
  )

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-page-title">Produtos</h1>
        <p className="text-sm text-muted-foreground">
          O catálogo inteiro, com a marcação de fora de coleção gerenciada aqui — sem depender
          de planilha. Marcações manuais sobrevivem a qualquer importação.
        </p>
      </div>

      <Tabs defaultValue="catalog">
        <TabsList>
          <TabsTrigger value="catalog">
            Catálogo ({formatInt(rows.length)})
          </TabsTrigger>
          <TabsTrigger value="legacy">
            Códigos legados ({formatInt(legacy.length)})
          </TabsTrigger>
        </TabsList>

        <TabsContent value="catalog" className="mt-4">
          <Card>
            <CardHeader>
              <div className="flex flex-wrap items-end justify-between gap-3">
                <div>
                  <CardTitle className="text-base">
                    {formatInt(rows.length - outCount)} em coleção · {formatInt(outCount)} fora
                    {useGroups && ` · ${formatInt(groups?.length ?? 0)} produtos na lista`}
                  </CardTitle>
                  <CardDescription>
                    {useGroups
                      ? 'Cada linha é um produto; abra para ver as variações. Estoque, trânsito, '
                        + 'demanda e quantidade a pedir são a soma da grade — o nível em que se '
                        + 'decide comprar. O interruptor da linha do produto vale para a grade inteira.'
                      : 'O interruptor marca o produto como fora de coleção: ele deixa de receber '
                        + 'estoque de segurança e sai da curva ABC no próximo recálculo.'}
                  </CardDescription>
                </div>
                <div className="flex items-center gap-2">
                  {hasGrades && (
                    <label className="flex cursor-pointer items-center gap-2 text-sm text-muted-foreground">
                      <Switch checked={grouped} onCheckedChange={setGrouped} />
                      Agrupar grade
                    </label>
                  )}
                  <Input
                    placeholder="Buscar por SKU ou nome…"
                    value={search}
                    onChange={(e) => setSearch(e.target.value)}
                    className="h-9 w-64"
                  />
                  <Select value={filter} onValueChange={(v) => setFilter(v as Filter)}>
                    <SelectTrigger className="h-9 w-44">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="all">Todos</SelectItem>
                      <SelectItem value="in">Em coleção</SelectItem>
                      <SelectItem value="out">Fora de coleção</SelectItem>
                      <SelectItem value="stocked">Com estoque</SelectItem>
                    </SelectContent>
                  </Select>
                  {allTags.length > 0 && (
                    <Select value={tagFilter} onValueChange={setTagFilter}>
                      <SelectTrigger className="h-9 w-36">
                        <SelectValue />
                      </SelectTrigger>
                      <SelectContent>
                        <SelectItem value="all">Todas as tags</SelectItem>
                        {allTags.map((t) => (
                          <SelectItem key={t} value={t}>{t}</SelectItem>
                        ))}
                        <SelectItem value="none">Sem tag</SelectItem>
                      </SelectContent>
                    </Select>
                  )}
                </div>
              </div>

              {selectedRows.length > 0 && (
                <div className="flex items-center gap-2 rounded-md border border-border bg-muted/50 px-3 py-2">
                  <span className="text-sm text-muted-foreground">
                    {formatInt(selectedRows.length)} selecionado(s)
                  </span>
                  <Button
                    size="sm" variant="outline" disabled={busy}
                    onClick={() => mark.mutate(selectedRows)}
                  >
                    Marcar fora de coleção
                  </Button>
                  <Button
                    size="sm" variant="outline" disabled={busy}
                    onClick={() => unmark.mutate(selectedRows)}
                  >
                    Voltar à coleção
                  </Button>
                </div>
              )}

              {/* Duas colunas do cálculo dependem de um snapshot. Sem ele elas
                  mostram "·", e o motivo fica escrito — em vez de zero, que
                  seria uma afirmação sobre a demanda. */}
              {!snapshot && (
                <p className="text-xs text-muted-foreground">
                  Demanda e “a pedir” aparecem depois do primeiro cálculo no Painel.
                </p>
              )}

              {useGroups && orphanCount > 0 && (
                <p className="text-xs text-warning-800">
                  {formatInt(orphanCount)} variações estão marcadas como variação no Tiny mas
                  sem produto pai apontado. Aparecem soltas na lista, com aviso: o vínculo está
                  quebrado no ERP e é lá que se conserta.
                </p>
              )}
            </CardHeader>
            <CardContent>
              {isLoading ? (
                <p className="py-8 text-center text-sm text-muted-foreground">Carregando…</p>
              ) : filtered.length === 0 ? (
                <p className="py-8 text-center text-sm text-muted-foreground">
                  Nenhum produto {search || filter !== 'all' ? 'com esse filtro' : 'importado ainda'}.
                </p>
              ) : (
                <Table>
                  <TableHeader>
                    <TableRow>
                      {useGroups && <TableHead className="w-9" />}
                      <TableHead className="w-10">
                        <Checkbox
                          checked={allSelected}
                          onCheckedChange={(c) =>
                            setSelected(c ? new Set(filtered.map((r) => r.id)) : new Set())}
                        />
                      </TableHead>
                      <TableHead>SKU</TableHead>
                      <TableHead>Produto</TableHead>
                      <TableHead>Tags</TableHead>
                      <TableHead>Categoria</TableHead>
                      <TableHead className="text-right">
                        <ColLabel term="estoque">Estoque</ColLabel>
                      </TableHead>
                      <TableHead className="text-right">
                        <ColLabel term="transito">Trânsito</ColLabel>
                      </TableHead>
                      <TableHead className="text-right">
                        <ColLabel term={useGroups ? 'demandaGrade' : 'demanda'}>
                          Demanda/sem
                        </ColLabel>
                      </TableHead>
                      <TableHead className="text-right">
                        <ColLabel term="pedir">A pedir</ColLabel>
                      </TableHead>
                      <TableHead className="text-right">
                        <ColLabel term="preco">Preço</ColLabel>
                      </TableHead>
                      <TableHead className="text-right">
                        <ColLabel term="cmv">CMV</ColLabel>
                      </TableHead>
                      <TableHead>Situação</TableHead>
                      <TableHead className="text-center">
                        <ColLabel term="foraDeColecao">Fora de coleção</ColLabel>
                      </TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {groups
                      ? groups.map((g) => {
                        if (!g.isGrade) return leafRow(g.parent, false)
                        // Age sobre o que está listado, não sobre a grade
                        // inteira: com filtro ligado, marcar a linha do produto
                        // não pode alcançar variações que a tela escondeu.
                        const ids = g.members.map((m) => m.id)
                        const variations = g.members.filter((m) => m.id !== g.parent.id)
                        const isOpen = open.has(g.parent.id)
                        const allOut = g.outOf === g.members.length
                        return (
                          <Fragment key={g.parent.id}>
                            <TableRow
                              className={[
                                'cursor-pointer border-t-2 border-t-border bg-surface-inset',
                                'hover:bg-surface-inset',
                                allOut ? 'opacity-70' : '',
                              ].filter(Boolean).join(' ')}
                              onClick={() => toggleOpen(g.parent.id)}
                            >
                              <TableCell className="w-9 p-0 text-center">
                                <span
                                  aria-hidden
                                  className="inline-flex h-6 w-6 items-center justify-center rounded-sm text-muted-foreground transition-colors hover:bg-mono-200 hover:text-foreground"
                                >
                                  {isOpen
                                    ? <ChevronDown className="h-4 w-4" />
                                    : <ChevronRight className="h-4 w-4" />}
                                </span>
                              </TableCell>
                              <TableCell onClick={(e) => e.stopPropagation()}>
                                <Checkbox
                                  checked={g.members.every((m) => selected.has(m.id))}
                                  onCheckedChange={(c) => toggleSelection(ids, !!c)}
                                />
                              </TableCell>
                              <TableCell className="font-mono text-xs">
                                {g.parent.sku ?? '—'}
                              </TableCell>
                              <TableCell
                                className="w-[340px] max-w-[340px]"
                                title={g.parent.name ?? undefined}
                              >
                                <div className="flex min-w-0 items-center gap-2">
                                  {/* O nome abre a ficha da GRADE SOMADA; o
                                      resto da linha continua abrindo/fechando
                                      as variações. Dois destinos na mesma linha
                                      porque são duas perguntas diferentes:
                                      "como vai essa grade" e "quais tamanhos
                                      tem". */}
                                  <Link
                                    to={`/analise/produto/${g.parent.id}`}
                                    onClick={(e) => e.stopPropagation()}
                                    className="min-w-0 flex-1 rounded-xs hover:text-brand-600 hover:underline"
                                  >
                                    <ProductCell image={g.parent.image_url} name={g.parent.name} />
                                  </Link>
                                  <Badge variant="outline" className="shrink-0 text-muted-foreground">
                                    {formatInt(variations.length)} var.
                                  </Badge>
                                </div>
                              </TableCell>
                              <TableCell><TagBadges tags={g.parent.tags} /></TableCell>
                              <TableCell className="max-w-[150px]">
                                {g.parent.category ? (
                                  <span className="block truncate text-xs text-muted-foreground" title={g.parent.category}>
                                    {g.parent.category.split('->').pop()!.trim()}
                                  </span>
                                ) : '—'}
                              </TableCell>
                              <TableCell className="text-right font-medium tabular-nums">
                                {formatInt(g.agg.stock)}
                              </TableCell>
                              <TableCell className="text-right font-medium tabular-nums">
                                {g.agg.transit > 0 ? formatInt(g.agg.transit) : '—'}
                              </TableCell>
                              <TableCell className="text-right font-medium tabular-nums">
                                {snapItems ? fmtWeekly(g.agg.weekly) : '·'}
                              </TableCell>
                              <TableCell className="text-right font-medium tabular-nums">
                                {snapItems ? (g.agg.toOrder > 0 ? formatInt(g.agg.toOrder) : '—') : '·'}
                              </TableCell>
                              <TableCell className="whitespace-nowrap text-right text-xs tabular-nums">
                                {priceRange(g.members.map((m) => n(m.sale_price)))}
                              </TableCell>
                              <TableCell className="whitespace-nowrap text-right text-xs tabular-nums">
                                {priceRange(g.members.map((m) => n(m.cmv)))}
                              </TableCell>
                              <TableCell>
                                <div className="flex flex-wrap items-center gap-1.5">
                                  <Badge variant="outline" className="text-muted-foreground">
                                    Grade
                                  </Badge>
                                  {g.outOf > 0 && !allOut && (
                                    <Badge variant="outline" className="border-warning-300 bg-warning-200 text-warning-800">
                                      {formatInt(g.outOf)} de {formatInt(g.members.length)} fora
                                    </Badge>
                                  )}
                                  {allOut && (
                                    <Badge variant="outline" className="border-warning-300 bg-warning-200 text-warning-800">
                                      Fora de coleção
                                    </Badge>
                                  )}
                                </div>
                              </TableCell>
                              <TableCell className="text-center" onClick={(e) => e.stopPropagation()}>
                                {/* O interruptor da grade vale para a grade inteira — é o
                                    nível em que se decide parar de recomprar um produto. */}
                                <Switch
                                  checked={allOut}
                                  disabled={busy}
                                  onCheckedChange={(c) => {
                                    if (busy) return
                                    if (c) mark.mutate(g.members)
                                    else unmark.mutate(g.members)
                                  }}
                                />
                              </TableCell>
                            </TableRow>
                            {isOpen && g.showSelf && leafRow(g.parent, true, true)}
                            {isOpen && variations.map((m) =>
                              leafRow(m, true, false, g.parent.name))}
                          </Fragment>
                        )
                      })
                      : filtered.map((r) => leafRow(r, false))}
                  </TableBody>
                </Table>
              )}
            </CardContent>
          </Card>
        </TabsContent>

        <TabsContent value="legacy" className="mt-4">
          <Card>
            <CardHeader>
              <div className="flex flex-wrap items-end justify-between gap-3">
                <div>
                  <CardTitle className="text-base">
                    {formatInt(legacy.length)} códigos sem produto no catálogo
                  </CardTitle>
                  <CardDescription>
                    Vieram da planilha de fora de coleção mas não casam com nenhum SKU do
                    catálogo atual. Não afetam o cálculo; removê-los só limpa a lista — e evita
                    que um SKU reutilizado no futuro nasça marcado por engano.
                  </CardDescription>
                </div>
                {legacy.length > 0 && (
                  <Button
                    size="sm" variant="outline" disabled={removeLegacy.isPending}
                    onClick={() => removeLegacy.mutate(legacy.map((d) => d.sku))}
                  >
                    Remover todos
                  </Button>
                )}
              </div>
            </CardHeader>
            <CardContent>
              {legacy.length === 0 ? (
                <p className="py-8 text-center text-sm text-muted-foreground">
                  Nenhum código legado — tudo que está marcado existe no catálogo.
                </p>
              ) : (
                <Table>
                  <TableHeader>
                    <TableRow>
                      <TableHead>SKU</TableHead>
                      <TableHead>Nome (da planilha)</TableHead>
                      <TableHead>Origem</TableHead>
                      <TableHead className="w-24" />
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {legacy.map((d) => (
                      <TableRow key={d.sku}>
                        <TableCell className="font-mono text-xs">{d.sku}</TableCell>
                        <TableCell className="max-w-[360px] truncate">{d.name ?? '—'}</TableCell>
                        <TableCell>
                          <Badge variant="outline" className="text-muted-foreground">
                            {d.source === 'manual' ? 'Manual' : 'Planilha'}
                          </Badge>
                        </TableCell>
                        <TableCell>
                          <Button
                            size="sm" variant="ghost" disabled={removeLegacy.isPending}
                            onClick={() => removeLegacy.mutate([d.sku])}
                          >
                            Remover
                          </Button>
                        </TableCell>
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>
              )}
            </CardContent>
          </Card>
        </TabsContent>
      </Tabs>
    </div>
  )
}
