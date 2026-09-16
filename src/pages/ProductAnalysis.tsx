import { useMemo, useState } from 'react'
import { useNavigate, useParams } from 'react-router-dom'
import {
  ArrowRight, Check, ChevronsUpDown, Package, Search, TrendingDown, TrendingUp,
  AlertTriangle, Layers, Snowflake,
} from 'lucide-react'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { Command, CommandEmpty, CommandInput, CommandItem, CommandList } from '@/components/ui/command'
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table'
import { ProductThumb } from '@/components/ProductThumb'
import { CardTitleRow } from '@/components/InfoHint'
import { ProductHistoryChart, buildHistory } from '@/components/charts/ProductHistoryChart'
import { LaunchCurveChart } from '@/components/charts/LaunchCurveChart'
import { useProductAnalysis, useProductPicker } from '@/hooks/useProductAnalysis'
import { useReplenishmentParams } from '@/hooks/useReplenishmentParams'
import { formatBRL, formatInt } from '@/lib/money'
import { num, maybeNum } from '@/lib/replenishment-types'
import type { ProductAnalysisData } from '@/hooks/useProductAnalysis'

/**
 * A ficha de um produto — onde a decisão deixa de ser sobre a carteira e passa
 * a ser sobre uma peça.
 *
 * A tela inteira sai de UMA consulta (`product_analysis`, 0032) porque ela
 * existe para trocar de produto: seis consultas por troca fariam a ficha
 * chegar em pedaços, cada painel no seu tempo. O seletor troca a URL, e a URL
 * é o estado — assim a ficha é compartilhável e o botão "voltar" funciona.
 *
 * O que NÃO tem aqui é ponto de pedido e estoque máximo. Eles existem, mas
 * moram no snapshot e são por SKU do motor; repeti-los aqui abriria a porta
 * para a ficha e o pedido de compra discordarem no dia em que alguém recalcular
 * com o outro aberto. Quem quer o número da compra vai ao Pedido de compra.
 */

const PERIODS = [30, 60, 90, 180, 365] as const
const PERIOD_LABEL: Record<number, string> = {
  30: '30 dias', 60: '60 dias', 90: '90 dias', 180: '180 dias', 365: '12 meses',
}

function fmtDate(iso: string | null | undefined): string {
  if (!iso) return '—'
  const [y, m, d] = iso.slice(0, 10).split('-')
  return `${d}/${m}/${y}`
}

function addDays(iso: string, n: number): string {
  const d = new Date(`${iso}T12:00:00`)
  d.setDate(d.getDate() + n)
  return d.toISOString().slice(0, 10)
}

function dec(v: number, places = 1): string {
  return v.toLocaleString('pt-BR', { minimumFractionDigits: places, maximumFractionDigits: places })
}

/**
 * Numa grade, o nome da variação repete o nome do pai inteiro. Numa tabela de
 * irmãos isso é a mesma frase em vinte linhas, e o que distingue as linhas —
 * cor e tamanho — fica no fim, fora da vista.
 */
function shortName(name: string | null, parent: string | null): string {
  if (!name) return '—'
  if (parent && name.startsWith(parent)) {
    const rest = name.slice(parent.length).replace(/^\s*-\s*/, '').trim()
    if (rest) return rest
  }
  return name
}

// ---------------------------------------------------------------------------

/**
 * O seletor de produto.
 *
 * Não usa o `SearchableSelect` comum porque aquele desenha TODAS as opções e
 * deixa o cmdk filtrar: com 2 mil produtos isso são 2 mil nós no popover a cada
 * abertura. Aqui o filtro é nosso e a lista é cortada em 40 — a busca por
 * digitação tem que responder no quadro seguinte.
 */
function ProductPicker({ value, onChange }: { value: string | undefined; onChange: (id: string) => void }) {
  const { data: products = [], isLoading } = useProductPicker()
  const [open, setOpen] = useState(false)
  const [q, setQ] = useState('')

  const selected = useMemo(() => products.find((p) => p.id === value), [products, value])

  const shown = useMemo(() => {
    // Todos os termos, em qualquer ordem. Um `includes` da frase inteira
    // exigiria que o usuário digitasse o nome na ordem do catálogo: "regata
    // chase" não acha "Regata Feminina Chase the High", e quem busca não sabe
    // que existe um "Feminina" no meio.
    const terms = q.trim().toLowerCase().split(/\s+/).filter(Boolean)
    // Dois baldes, e a grade vem primeiro. Buscar "bermuda" numa lista única
    // devolveria quarenta tamanhos da mesma bermuda e nenhuma bermuda —
    // cada grade traz 25 variações consigo, e o corte em 40 cairia dentro da
    // primeira. Quem procura pelo SKU da variação ainda acha, porque ela
    // continua na lista; só não ocupa a frente dela.
    const grades = []
    const vars = []
    for (const p of products) {
      const hay = `${p.sku ?? ''} ${p.name ?? ''}`.toLowerCase()
      if (!terms.every((t) => hay.includes(t))) continue
      if (p.variation_type === 'V') vars.push(p)
      else grades.push(p)
      if (grades.length + vars.length >= 400) break
    }
    return [...grades, ...vars].slice(0, 40)
  }, [products, q])

  return (
    <Popover open={open} onOpenChange={setOpen} modal={false}>
      <PopoverTrigger asChild>
        <Button
          type="button"
          variant="outline"
          role="combobox"
          aria-expanded={open}
          aria-label="Escolher produto"
          disabled={isLoading}
          className="h-control-sm w-full justify-between gap-1.5 rounded-sm border-border bg-surface px-2.5 text-[13px] font-medium shadow-none hover:border-border-strong data-[state=open]:border-brand-600 sm:w-[420px]"
        >
          <Search className="h-3.5 w-3.5 shrink-0 text-mono-500" />
          <span className="min-w-0 flex-1 truncate text-left">
            {selected
              ? `${selected.sku ? `${selected.sku} · ` : ''}${selected.name ?? ''}`
              : isLoading ? 'Carregando catálogo…' : 'Escolher produto…'}
          </span>
          <ChevronsUpDown className="h-3.5 w-3.5 shrink-0 text-mono-500" />
        </Button>
      </PopoverTrigger>
      <PopoverContent align="start" className="z-[80] w-[min(100vw-2rem,520px)] p-0 shadow-dropdown">
        <Command shouldFilter={false}>
          <CommandInput placeholder="Buscar por SKU ou nome…" value={q} onValueChange={setQ} />
          <CommandList className="max-h-[360px]">
            <CommandEmpty>Nenhum produto encontrado.</CommandEmpty>
            {shown.map((p) => (
              <CommandItem
                key={p.id}
                value={p.id}
                onSelect={() => { onChange(p.id); setOpen(false); setQ('') }}
                className="gap-2"
              >
                <Check className={`h-3.5 w-3.5 shrink-0 ${p.id === value ? 'text-brand-600' : 'opacity-0'}`} />
                <ProductThumb src={p.image_url} alt={p.name ?? 'Produto'} />
                <span className="min-w-0 flex-1">
                  <span className="block truncate text-xs">{p.name ?? '—'}</span>
                  <span className="block font-data text-micro text-muted-foreground">{p.sku ?? 'sem SKU'}</span>
                </span>
                {/* O pai é uma coisa diferente do filho e tem que dizer isso na
                    lista: os dois têm o mesmo nome, e sem o rótulo a escolha
                    seria entre duas linhas idênticas. */}
                {p.variation_type === 'P' && (
                  <span className="shrink-0 rounded-xs bg-brand-100 px-1.5 py-0.5 text-micro font-medium text-brand-700">
                    grade
                  </span>
                )}
              </CommandItem>
            ))}
            {/* Dizer que a lista foi cortada. Sem isso, quem busca "preto" vê
                quarenta resultados e conclui que são todos. */}
            {shown.length >= 40 && (
              <p className="px-3 py-2 text-micro text-muted-foreground">
                Mostrando os 40 primeiros — refine a busca.
              </p>
            )}
          </CommandList>
        </Command>
      </PopoverContent>
    </Popover>
  )
}

// ---------------------------------------------------------------------------

type Tone = 'plain' | 'warn' | 'bad'

function Kpi({ label, value, hint, chip, tone = 'plain' }: {
  label: string
  value: string
  hint: string
  chip?: string
  tone?: Tone
}) {
  return (
    <Card>
      <CardContent className="space-y-1 p-4">
        <div className="flex items-center justify-between gap-2">
          <span className="text-micro uppercase tracking-wide text-muted-foreground">{label}</span>
          {chip && (
            <span className={`shrink-0 rounded-xs px-1.5 py-0.5 text-micro font-medium ${
              tone === 'bad' ? 'bg-danger-soft text-destructive'
                : tone === 'warn' ? 'bg-warning-100 text-warning-800'
                  : 'bg-surface-inset text-muted-foreground'
            }`}>
              {chip}
            </span>
          )}
        </div>
        <p className={`font-data text-2xl font-semibold leading-tight tabular-nums ${
          tone === 'bad' ? 'text-destructive' : ''
        }`}>
          {value}
        </p>
        <p className="text-micro text-muted-foreground">{hint}</p>
      </CardContent>
    </Card>
  )
}

// ---------------------------------------------------------------------------

interface Insight {
  key: string
  icon: typeof AlertTriangle
  tone: Tone
  title: string
  body: string
  action: string
}

/**
 * Os insights saem todos de número que está na tela — nenhum deles é opinião
 * escondida atrás de linguagem. Cada um diz o número que o disparou, para que
 * dê para discordar dele.
 */
function buildInsights(d: ProductAnalysisData, leadTime: number): Insight[] {
  const out: Insight[] = []
  const stock = num(d.stock)
  const w = (n: number) => d.windows.find((x) => x.days === n)
  const w30 = w(30)
  const w90 = w(90)

  const rate30 = w30 && w30.effective_days > 0 ? num(w30.units) / w30.effective_days : 0
  const rate90 = w90 && w90.effective_days > 0 ? num(w90.units) / w90.effective_days : 0
  const cover = rate30 > 0 ? stock / rate30 : null

  if (stock <= 0 && rate90 > 0) {
    out.push({
      key: 'ruptura',
      icon: AlertTriangle,
      tone: 'bad',
      title: 'Sem estoque, com demanda',
      body: `Saldo zerado e ${formatInt(num(w90?.units))} peças vendidas em 90 dias `
        + `(${dec(rate90, 2)} un/dia). Cada dia parado é venda que não acontece.`,
      action: 'Repor com prioridade ou tirar de linha — hoje o produto só ocupa vitrine.',
    })
  } else if (cover != null && cover < leadTime) {
    out.push({
      key: 'antes-do-lead',
      icon: AlertTriangle,
      tone: 'warn',
      title: 'Acaba antes de a reposição chegar',
      body: `Cobertura de ${formatInt(Math.floor(cover))} dias contra lead time de ${leadTime} dias. `
        + `Ruptura estimada em ${fmtDate(addDays(d.today, Math.floor(cover)))}.`,
      action: 'Pedir agora — pedir depois já chega atrasado.',
    })
  }

  // Grade desbalanceada: irmão com estoque e sem venda nenhuma no período.
  // Só faz sentido com grade; num produto avulso `siblings` é só ele mesmo.
  if (d.siblings.length > 1) {
    const dead = d.siblings.filter((s) => num(s.stock) > 0 && num(s.units) === 0)
    const deadQty = dead.reduce((a, s) => a + num(s.stock), 0)
    if (dead.length > 0) {
      const price = num(d.product.sale_price)
      out.push({
        key: 'grade',
        icon: Layers,
        tone: 'warn',
        title: 'Grade desbalanceada',
        body: `${dead.length} ${dead.length === 1 ? 'variação' : 'variações'} da mesma grade `
          + `${dead.length === 1 ? 'soma' : 'somam'} ${formatInt(deadQty)} peças em estoque `
          + `sem uma única venda em ${d.days} dias`
          + (price > 0 ? ` — ${formatBRL(deadQty * price)} a preço de venda.` : '.'),
        action: 'Descontar progressivamente ou parar de repor essas variações — o estoque bom paga o ruim.',
      })
    }
  }

  if (rate30 > 0 && rate90 > 0) {
    const delta = rate30 / rate90 - 1
    if (delta >= 0.25) {
      out.push({
        key: 'acelera',
        icon: TrendingUp,
        tone: 'plain',
        title: 'Demanda acelerando',
        body: `${dec(rate30, 2)} un/dia nos últimos 30 dias contra ${dec(rate90, 2)} nos 90 — `
          + `${dec(delta * 100, 0)}% acima do próprio ritmo médio.`,
        action: 'Conferir se o ponto de pedido ainda cabe: ele foi calculado com o ritmo antigo.',
      })
    } else if (delta <= -0.25) {
      out.push({
        key: 'desacelera',
        icon: TrendingDown,
        tone: 'plain',
        title: 'Demanda desacelerando',
        body: `${dec(rate30, 2)} un/dia nos últimos 30 dias contra ${dec(rate90, 2)} nos 90 — `
          + `${dec(Math.abs(delta) * 100, 0)}% abaixo do próprio ritmo médio.`,
        action: 'Segurar a próxima compra até entender se é sazonal ou é fim de ciclo.',
      })
    }
  }

  if (cover != null && cover > 180 && stock > 0) {
    // Custo somado peça a peça no banco, não `cmv × saldo`: numa grade o custo
    // do pai é uma média e multiplicá-la pelo saldo total erra.
    const cost = num(d.stock_cost)
    out.push({
      key: 'parado',
      icon: Snowflake,
      tone: 'plain',
      title: 'Capital parado',
      body: `${formatInt(stock)} peças para ${formatInt(Math.floor(cover))} dias de venda`
        + (cost > 0 ? ` — ${formatBRL(cost)} a custo dormindo na prateleira.` : '.'),
      action: 'Não repor e considerar promoção: o dinheiro preso aqui não compra o que gira.',
    })
  }

  if (rate90 === 0) {
    out.push({
      key: 'sem-venda',
      icon: Snowflake,
      tone: 'plain',
      title: 'Sem venda em 90 dias',
      body: stock > 0
        ? `${formatInt(stock)} peças em estoque e nenhuma saída desde ${fmtDate(d.last_sale)}.`
        : 'Nenhuma saída no período e nenhum saldo — o produto está inerte.',
      action: 'Decidir explicitamente: liquidar ou marcar como fora de coleção.',
    })
  }

  return out
}

// ---------------------------------------------------------------------------

export default function ProductAnalysis() {
  const { productId } = useParams<{ productId: string }>()
  const navigate = useNavigate()
  const [days, setDays] = useState<number>(90)

  const { data, isLoading, isError, error } = useProductAnalysis(productId, days)
  const { data: params } = useReplenishmentParams()
  const leadTime = params?.lead_time_days ?? 80

  const history = useMemo(() => {
    if (!data) return null
    return buildHistory(
      data.daily.map((x) => ({ d: x.d, u: num(x.u), r: num(x.r) })),
      data.from, data.today, num(data.stock),
    )
  }, [data])

  const stock = num(data?.stock)
  const stockValue = num(data?.stock_value)
  const price = num(data?.product.sale_price)
  const cmv = maybeNum(data?.product.cmv)

  /**
   * Sell-through: quanto do que entrou já saiu.
   *
   * O denominador não precisa do histórico de recebimento que a base não tem.
   * Pela identidade de conservação,
   *
   *     estoque inicial + recebido = vendido + estoque final
   *
   * e o produto nasceu com estoque inicial zero, então `recebido = vendido +
   * saldo de hoje`. O recebimento desconhecido se cancela e o número é EXATO —
   * ao contrário da linha de estoque do gráfico acima, que é estimada.
   *
   * A ressalva que sobra: o saldo é o disponível (só depósitos marcados como
   * tal), a mesma definição do motor e da cobertura. Usar outra aqui faria a
   * ficha discordar do Pedido de compra.
   */
  const totalUnits = num(data?.total_units)
  const everIn = totalUnits + stock
  const sellThrough = everIn > 0 ? totalUnits / everIn : null

  const launch = useMemo(
    () => (data?.launch ?? []).map((w) => ({
      week: w.week, units: num(w.units), revenue: num(w.revenue), days: w.days,
    })),
    [data])

  const launchStats = useMemo(() => {
    if (launch.length === 0) return null
    const first4 = launch.slice(0, 4).reduce((a, w) => a + w.units, 0)
    const peak = launch.reduce((b, w) => (w.units > b.units ? w : b), launch[0])
    return { first4, peak, sold: launch.reduce((a, w) => a + w.units, 0) }
  }, [launch])

  const w30 = data?.windows.find((x) => x.days === 30)
  const rate30 = w30 && w30.effective_days > 0 ? num(w30.units) / w30.effective_days : 0
  const cover = rate30 > 0 ? stock / rate30 : null
  const partial = !!w30 && w30.effective_days < 30

  const markup = cmv && cmv > 0 ? price / cmv : null
  const margin = price > 0 && cmv != null ? (price - cmv) / price : null

  const insights = useMemo(
    () => (data ? buildInsights(data, leadTime) : []),
    [data, leadTime])

  const pick = (id: string) => navigate(`/analise/produto/${id}`, { replace: true })

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <p className="text-sm text-muted-foreground">
          Quanto sai, quanto sobra e o que a grade esconde.
        </p>
        <div className="flex flex-wrap items-center gap-2">
          <ProductPicker value={productId} onChange={pick} />
          <Select value={String(days)} onValueChange={(v) => setDays(Number(v))}>
            <SelectTrigger className="h-control-sm w-[120px] rounded-sm text-[13px]">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {PERIODS.map((p) => (
                <SelectItem key={p} value={String(p)}>{PERIOD_LABEL[p]}</SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
      </div>

      {!productId ? (
        <Card>
          <CardContent className="flex flex-col items-center gap-2 py-16 text-center">
            <Package className="h-6 w-6 text-muted-foreground" />
            <p className="text-sm text-muted-foreground">
              Escolha um produto acima para ver a ficha.
            </p>
          </CardContent>
        </Card>
      ) : isError ? (
        <Card>
          <CardContent className="py-10 text-center text-sm text-destructive">
            {(error as Error)?.message ?? 'Não foi possível carregar a ficha.'}
          </CardContent>
        </Card>
      ) : isLoading || !data ? (
        <div className="space-y-4">
          <div className="h-24 animate-pulse rounded-lg bg-surface-inset" />
          <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
            {[0, 1, 2, 3].map((k) => (
              <div key={k} className="h-28 animate-pulse rounded-lg bg-surface-inset" />
            ))}
          </div>
          <div className="h-80 animate-pulse rounded-lg bg-surface-inset" />
        </div>
      ) : (
        <>
          {/* Cabeçalho da peça */}
          <Card>
            <CardContent className="flex flex-wrap items-start gap-4 p-4">
              <div className="h-20 w-20 shrink-0 overflow-hidden rounded-lg border border-border bg-white">
                {data.product.image_url ? (
                  <img
                    src={data.product.image_url}
                    alt={data.product.name ?? 'Produto'}
                    className="h-full w-full object-contain"
                  />
                ) : (
                  <div className="flex h-full w-full items-center justify-center bg-muted">
                    <Package className="h-6 w-6 text-muted-foreground" />
                  </div>
                )}
              </div>
              <div className="min-w-0 flex-1 space-y-1.5">
                <div className="flex flex-wrap items-center gap-2">
                  <h2 className="text-base font-semibold">{data.product.name ?? '—'}</h2>
                  {data.is_grade && (
                    <Badge variant="outline" className="border-brand-300 bg-brand-100 text-brand-700">
                      Grade · {data.scope_size} variações
                    </Badge>
                  )}
                  {!data.product.is_active && <Badge variant="outline">Inativo</Badge>}
                  {(data.product.tags ?? []).map((t) => (
                    <Badge key={t} variant="outline" className="border-violet-300 bg-violet-200 text-violet-800">
                      {t}
                    </Badge>
                  ))}
                </div>
                {/* O caminho de volta para o agregado. Sem ele, quem desceu
                    numa variação pela tabela de grade só sobe pelo botão
                    "voltar" do navegador — e a navegação aqui é `replace`, então
                    o voltar leva para Produtos, não para a grade. */}
                {!data.is_grade && data.product.parent_id && (
                  <button
                    type="button"
                    onClick={() => pick(data.product.parent_id!)}
                    className="inline-flex items-center gap-1 text-xs font-medium text-brand-600 hover:underline"
                  >
                    <Layers className="h-3 w-3" />
                    Ver a grade inteira somada
                  </button>
                )}
                <div className="flex flex-wrap items-center gap-x-4 gap-y-1 text-xs text-muted-foreground">
                  <span className="font-data">{data.product.sku ?? 'sem SKU'}</span>
                  {data.product.brand && <span>{data.product.brand}</span>}
                  {data.product.category && (
                    <span className="truncate" title={data.product.category}>{data.product.category}</span>
                  )}
                  <span>1ª venda {fmtDate(data.first_sale)}</span>
                  <span>última venda {fmtDate(data.last_sale)}</span>
                  <span>{formatInt(num(data.total_units))} peças vendidas desde sempre</span>
                </div>
              </div>
            </CardContent>
          </Card>

          {/* Os números de cabeceira */}
          <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-5">
            <Kpi
              label="Estoque"
              value={`${formatInt(stock)} un`}
              tone={stock <= 0 ? 'bad' : 'plain'}
              chip={stock <= 0 ? 'Sem estoque'
                : data.is_grade ? `${data.scope_size} variações` : undefined}
              // `stock_value` vem somado peça a peça no banco, com o preço de
              // cada variação. Multiplicar o saldo da grade pelo preço do pai
              // erraria em toda grade que mistura tamanho caro e barato.
              hint={stockValue > 0
                ? `${formatBRL(stockValue)} a preço de venda`
                  + (num(data.in_transit) > 0 ? ` · ${formatInt(num(data.in_transit))} em trânsito` : '')
                : 'sem preço de venda no catálogo'}
            />
            <Kpi
              label="Sell-through"
              value={sellThrough == null ? '—' : `${dec(sellThrough * 100, 1)}%`}
              // Sem verde, e sem vermelho: sell-through baixo num lançamento de
              // duas semanas é normal, e alto num produto que nunca foi reposto
              // é ruptura. O número vale contra a idade, que está no gráfico
              // logo abaixo — pintá-lo aqui seria julgar sem esse contexto.
              tone="plain"
              // Os outros KPIs falam dos últimos 30 dias; este fala da vida
              // inteira. Sem dizer isso, dois números da mesma tela pareceriam
              // medir a mesma janela.
              chip="Vida inteira"
              hint={sellThrough == null
                ? 'nunca vendeu e não há saldo — nada entrou por aqui'
                : `${formatInt(totalUnits)} vendidas de ${formatInt(everIn)} que entraram`}
            />
            <Kpi
              label="Cobertura"
              value={cover == null ? '—' : `${formatInt(Math.floor(cover))} dias`}
              tone={stock <= 0 ? 'bad' : cover != null && cover < leadTime ? 'warn' : 'plain'}
              chip={stock <= 0 ? 'Zerado'
                : cover != null && cover < leadTime ? 'Atenção' : undefined}
              // Sem verde aqui de propósito: cobertura alta não é boa notícia,
              // é capital parado. Pintá-la de verde seria elogiar o defeito.
              hint={cover == null
                ? 'sem venda nos últimos 30 dias — não há ritmo para dividir'
                : `ruptura estimada em ${fmtDate(addDays(data.today, Math.floor(cover)))}, ao ritmo de 30 dias`}
            />
            <Kpi
              label="Demanda"
              value={`${dec(rate30, 2)} un/dia`}
              chip={partial ? 'Dados parciais' : undefined}
              tone="plain"
              hint={partial
                ? `o produto só existiu ${w30?.effective_days} dos 30 dias — a média é sobre esses`
                : `${w30?.days_with_sale ?? 0} dos 30 dias tiveram venda`}
            />
            <Kpi
              label="Markup"
              value={markup == null ? '—' : `${dec(markup, 2)}×`}
              tone="plain"
              chip={data.is_grade ? 'Médio' : undefined}
              hint={margin == null
                ? 'sem custo no catálogo — margem não calculável'
                : `margem de ${dec(margin * 100, 1)}% · custo ${formatBRL(cmv ?? 0)}`}
            />
          </div>

          {/* Histórico */}
          <Card>
            <CardHeader className="pb-3">
              <CardTitleRow
                noteLabel="Como a linha de estoque é reconstruída"
                note={
                  <>
                    <p>
                      <strong className="text-ink">A venda é exata.</strong> O estoque não: a base
                      não tem data de recebimento, então a linha é reconstruída para trás a partir
                      do saldo de hoje somando o que saiu.
                    </p>
                    <p>
                      Como a reposição não entra nessa conta, a curva é um{' '}
                      <strong className="text-ink">limite superior</strong> do que havia. Por isso
                      é tracejada — e por isso o giro é anualizado sobre o estoque de hoje, o único
                      que é medido.
                    </p>
                  </>
                }
              >
                <CardTitle className="text-card-title">Vendas e estoque</CardTitle>
                <CardDescription>
                  {fmtDate(data.from)} a {fmtDate(data.today)}
                </CardDescription>
              </CardTitleRow>
            </CardHeader>
            <CardContent className="pt-0">
              {history && history.points.length > 0 ? (
                <ProductHistoryChart points={history.points} weekly={history.weekly} />
              ) : (
                <p className="py-10 text-center text-xs text-muted-foreground">Sem dados no período.</p>
              )}
            </CardContent>
          </Card>

          {/* Curva de lançamento */}
          {launch.length > 0 && launchStats && (
            <Card>
              <CardHeader className="pb-3">
                <CardTitleRow
                  noteLabel="Como a curva de lançamento é montada"
                  note={
                    <>
                      <p>
                        O eixo é a <strong className="text-ink">idade</strong> do produto, não o
                        calendário: assim dois lançamentos de meses diferentes ficam com as
                        semanas 1 uma sobre a outra. Por isso a curva ignora o período escolhido
                        no alto da tela — um lançamento não cabe em 30 dias.
                      </p>
                      <p>
                        A última semana costuma estar em curso, e sai em tom claro para não
                        desenhar uma queda que é só o calendário não ter acabado.
                      </p>
                      <p>
                        O <strong className="text-ink">sell-through acumulado</strong> é exato
                        mesmo sem histórico de recebimento: tudo que entrou ou já saiu ou está no
                        saldo de hoje, então o recebimento desconhecido se cancela. O saldo é o
                        disponível, a mesma definição da cobertura e do pedido de compra.
                      </p>
                    </>
                  }
                >
                  <CardTitle className="text-card-title">Desde o lançamento</CardTitle>
                  <CardDescription>
                    Semana a semana desde a 1ª venda, {fmtDate(data.first_sale)}
                    {data.is_grade ? ' · grade somada' : ''}
                  </CardDescription>
                </CardTitleRow>
              </CardHeader>
              <CardContent className="space-y-4 pt-0">
                {/* Duas leituras que o desenho sozinho não entrega: quanto da
                    venda aconteceu no fôlego inicial, e quando foi o pico. */}
                <div className="flex flex-wrap gap-x-6 gap-y-2">
                  <div>
                    <p className="font-data text-lg font-semibold leading-tight tabular-nums">
                      {launchStats.sold > 0
                        ? `${dec((launchStats.first4 / launchStats.sold) * 100, 0)}%`
                        : '—'}
                    </p>
                    <p className="text-micro text-muted-foreground">
                      da venda nas 4 primeiras semanas
                      {launch.length < 4 ? ` (só ${launch.length} até agora)` : ''}
                    </p>
                  </div>
                  <div>
                    <p className="font-data text-lg font-semibold leading-tight tabular-nums">
                      Semana {launchStats.peak.week}
                    </p>
                    <p className="text-micro text-muted-foreground">
                      pico, com {formatInt(launchStats.peak.units)} un
                    </p>
                  </div>
                  <div>
                    <p className="font-data text-lg font-semibold leading-tight tabular-nums">
                      {launch.length} {launch.length === 1 ? 'semana' : 'semanas'}
                    </p>
                    <p className="text-micro text-muted-foreground">de vida em venda</p>
                  </div>
                </div>
                {/* Esta ressalva NÃO vai para a nota: ela depende do produto —
                    vale em 14% do catálogo — e quem olha uma curva de lançamento
                    assume que a semana 1 é o lançamento. Escondida, ela chega
                    depois da conclusão errada. */}
                {data.launch_censored && (
                  <p className="flex items-start gap-1.5 text-micro text-warning-800">
                    <AlertTriangle className="mt-0.5 h-3 w-3 shrink-0" />
                    <span>
                      A semana 1 é o começo dos <strong>dados</strong> ({fmtDate(data.base_start)}),
                      não necessariamente o lançamento — venda anterior a isso não foi importada.
                    </span>
                  </p>
                )}
                <LaunchCurveChart weeks={launch} denom={everIn} />
              </CardContent>
            </Card>
          )}

          <div className="grid gap-4 lg:grid-cols-2">
            {/* Giro */}
            <Card className="flex flex-col">
              <CardHeader className="pb-3">
                <CardTitleRow
                  noteLabel="Como o giro é calculado"
                  note={
                    <>
                      <p>
                        As janelas são <strong className="text-ink">fixas</strong> e não seguem o
                        período escolhido acima: elas servem para comparar ritmos entre si, e uma
                        mudando de tamanho junto com o seletor destruiria a comparação.
                      </p>
                      <p>
                        <strong className="text-ink">Efetivo</strong> só aparece quando o produto
                        é mais novo que a janela — a média é sobre os dias em que ele existiu,
                        senão um lançamento de 10 dias pareceria parado numa janela de 90.
                      </p>
                      <p>
                        O giro é anualizado sobre o <strong className="text-ink">estoque de
                        hoje</strong>, que é o único saldo medido.
                      </p>
                    </>
                  }
                >
                  <CardTitle className="text-card-title">Giro de estoque</CardTitle>
                  <CardDescription>Janelas fixas, para comparar ritmos entre si</CardDescription>
                </CardTitleRow>
              </CardHeader>
              <CardContent className="flex-1 pt-0">
                <Table>
                  <TableHeader>
                    <TableRow>
                      <TableHead>Janela</TableHead>
                      <TableHead className="text-right">Efetivo</TableHead>
                      <TableHead className="text-right">Vendas</TableHead>
                      <TableHead className="text-right">Un/dia</TableHead>
                      <TableHead className="text-right">Giro/ano</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {data.windows.map((wd) => {
                      const units = num(wd.units)
                      const rate = wd.effective_days > 0 ? units / wd.effective_days : 0
                      const turns = stock > 0 ? (rate * 365) / stock : null
                      return (
                        <TableRow key={wd.days}>
                          <TableCell className="font-medium">{wd.days} dias</TableCell>
                          <TableCell className="text-right font-data text-xs tabular-nums text-muted-foreground">
                            {wd.effective_days < wd.days ? `${wd.effective_days} d` : '—'}
                          </TableCell>
                          <TableCell className="text-right font-data tabular-nums">
                            {formatInt(units)}
                            <span className="ml-1 text-micro text-muted-foreground">
                              · {wd.days_with_sale}d c/ venda
                            </span>
                          </TableCell>
                          <TableCell className="text-right font-data tabular-nums">{dec(rate, 2)}</TableCell>
                          <TableCell className="text-right font-data font-medium tabular-nums">
                            {turns == null ? '—' : `${dec(turns, 1)}×`}
                          </TableCell>
                        </TableRow>
                      )
                    })}
                  </TableBody>
                </Table>
              </CardContent>
            </Card>

            {/* Insights */}
            <Card className="flex flex-col">
              <CardHeader className="pb-3">
                <CardTitle className="text-card-title">Insights automáticos</CardTitle>
                <CardDescription>Cada um diz o número que o disparou</CardDescription>
              </CardHeader>
              <CardContent className="flex-1 pt-0">
                {insights.length === 0 ? (
                  <p className="py-8 text-center text-xs text-muted-foreground">
                    Nada fora do lugar: estoque compatível com a demanda, sem ritmo mudando e
                    sem variação encalhada na grade.
                  </p>
                ) : (
                  <ul className="space-y-3">
                    {insights.map((i) => (
                      <li key={i.key} className="flex gap-2.5">
                        <span className={`mt-0.5 flex h-6 w-6 shrink-0 items-center justify-center rounded-sm ${
                          i.tone === 'bad' ? 'bg-danger-soft text-destructive'
                            : i.tone === 'warn' ? 'bg-warning-100 text-warning-800'
                              : 'bg-brand-100 text-brand-700'
                        }`}>
                          <i.icon className="h-3.5 w-3.5" />
                        </span>
                        <div className="min-w-0">
                          <p className="text-xs font-medium">{i.title}</p>
                          <p className="text-xs text-muted-foreground">{i.body}</p>
                          <p className="mt-0.5 text-micro text-muted-foreground">
                            <span className="font-medium text-ink">Ação: </span>{i.action}
                          </p>
                        </div>
                      </li>
                    ))}
                  </ul>
                )}
              </CardContent>
            </Card>
          </div>

          {/* A grade */}
          {data.siblings.length > 1 && (
            <Card>
              <CardHeader className="pb-3">
                <CardTitleRow
                  noteLabel="Como ler a grade"
                  note={
                    <p>
                      Variação com estoque e <strong className="text-ink">nenhuma venda</strong>{' '}
                      aparece em âmbar: é o tamanho ou a cor que segura a compra da grade inteira.
                      Estoque parado num tamanho não aparece olhando só para a linha escolhida.
                    </p>
                  }
                >
                  <CardTitle className="text-card-title">Grade</CardTitle>
                  <CardDescription>
                    {data.siblings.length} variações
                    {data.is_grade
                      ? ' — são elas que somam os números acima'
                      : ` de ${data.product.parent_name ?? 'da mesma linha'}`}
                    {' '}· vendas em {data.days} dias
                  </CardDescription>
                </CardTitleRow>
              </CardHeader>
              <CardContent className="pt-0">
                <Table>
                  <TableHeader>
                    <TableRow>
                      <TableHead>SKU</TableHead>
                      <TableHead>Variação</TableHead>
                      <TableHead className="text-right">Estoque</TableHead>
                      <TableHead className="text-right">Vendas</TableHead>
                      <TableHead className="text-right">Cobertura</TableHead>
                      <TableHead className="w-8" />
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {data.siblings.map((s) => {
                      const sStock = num(s.stock)
                      const sUnits = num(s.units)
                      const sRate = sUnits / Math.max(1, data.days)
                      const sCover = sRate > 0 ? sStock / sRate : null
                      const self = s.id === data.product.id
                      return (
                        <TableRow
                          key={s.id}
                          onClick={() => !self && pick(s.id)}
                          className={self
                            ? 'bg-brand-100/50'
                            : 'cursor-pointer'}
                        >
                          <TableCell className="font-data text-xs">{s.sku ?? '—'}</TableCell>
                          <TableCell className={self ? 'font-medium' : ''}>
                            {/* Escolhido o pai, o prefixo a cortar é o nome
                                DELE: `parent_name` é nulo num pai, e sem isso
                                a coluna repetiria a frase inteira 25 vezes. */}
                            {shortName(s.name, data.is_grade ? data.product.name : data.product.parent_name)}
                          </TableCell>
                          <TableCell className="text-right font-data tabular-nums">
                            {formatInt(sStock)}
                          </TableCell>
                          <TableCell className={`text-right font-data tabular-nums ${
                            sUnits === 0 && sStock > 0 ? 'text-warning-800' : ''
                          }`}>
                            {sUnits === 0 ? '—' : formatInt(sUnits)}
                          </TableCell>
                          <TableCell className="text-right font-data tabular-nums text-muted-foreground">
                            {sCover == null
                              ? (sStock > 0 ? 'não vendeu' : '—')
                              : `${formatInt(Math.floor(sCover))} d`}
                          </TableCell>
                          <TableCell className="text-right">
                            {!self && <ArrowRight className="h-3.5 w-3.5 text-muted-foreground" />}
                          </TableCell>
                        </TableRow>
                      )
                    })}
                  </TableBody>
                </Table>
              </CardContent>
            </Card>
          )}

          {/* Depósitos */}
          {data.warehouses.length > 0 && (
            <Card>
              <CardHeader className="pb-3">
                <CardTitle className="text-card-title">Onde está o estoque</CardTitle>
                <CardDescription>
                  Só o que conta como disponível entra na cobertura acima
                </CardDescription>
              </CardHeader>
              <CardContent className="pt-0">
                <ul className="divide-y divide-border">
                  {data.warehouses.map((wh) => (
                    <li key={wh.name} className="flex items-center justify-between gap-3 py-2 text-xs">
                      <span className="min-w-0 truncate">{wh.name}</span>
                      <span className="flex shrink-0 items-center gap-2">
                        {!wh.available && (
                          <span className="rounded-xs bg-surface-inset px-1.5 py-0.5 text-micro text-muted-foreground">
                            fora do disponível
                          </span>
                        )}
                        <span className="font-data font-medium tabular-nums">
                          {formatInt(num(wh.qty))} un
                        </span>
                      </span>
                    </li>
                  ))}
                </ul>
              </CardContent>
            </Card>
          )}
        </>
      )}
    </div>
  )
}
