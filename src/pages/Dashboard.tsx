import { useEffect, useMemo, useState } from 'react'
import { Link } from 'react-router-dom'
import {
  AlertTriangle, Boxes, Package, Receipt, ShoppingCart, Wallet,
} from 'lucide-react'
import { DashboardFilters } from '@/components/DashboardFilters'
import { useCompany } from '@/contexts/CompanyContext'
import { PERIOD_LABELS, periodRange } from '@/lib/dashboard-period'
import type { PeriodKey } from '@/lib/dashboard-period'
import { scopeToWarehouses, totalsOf } from '@/lib/warehouse-scope'
import { useDashboardCensus, useStockByWarehouses } from '@/hooks/useDashboardCensus'
import { useProductGrades } from '@/hooks/useProductGrades'
import { useDemandProfile, useInTransitEta } from '@/hooks/useProjectionInputs'
import type { TransitIndex } from '@/hooks/useProjectionInputs'
import { useCurrentSnapshot, useSnapshotItems } from '@/hooks/useCurrentSnapshot'
import { useReplenishmentParams } from '@/hooks/useReplenishmentParams'
import { formatBRL, formatBRLCompact, formatInt } from '@/lib/money'
import { num } from '@/lib/replenishment-types'
import type { SnapshotItem } from '@/lib/replenishment-types'
import { analyseIdleCapital } from '@/lib/idle-capital'
import { IdleCapitalCard } from '@/components/charts/IdleCapitalCard'
import { AbcSummaryCard } from '@/components/dashboard/AbcSummaryCard'
import { TopColorsCard } from '@/components/dashboard/TopColorsCard'
import { SalesByCategoryCard } from '@/components/dashboard/SalesByCategoryCard'
import { SoldTogetherCard, UpsellCard } from '@/components/dashboard/BasketCards'
import { StockProjectionChart } from '@/components/charts/StockProjectionChart'
import type { ProjectionItem } from '@/components/charts/StockProjectionChart'
import { LoadingBlock } from '@/components/brand/Logo'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { SearchableSelect } from '@/components/ui/searchable-select'

function pctLabel(v: number): string {
  return `${(v * 100).toLocaleString('pt-BR', { maximumFractionDigits: 1 })}%`
}

/**
 * Uma célula da faixa de indicadores. O rodapé é o contexto do número.
 *
 * `loading` existe porque três dos quatro indicadores dependem das linhas do
 * snapshot, que chegam paginadas — e com a carteira grande isso são vários
 * segundos. Sem o estado de carga a faixa afirma "Capital parado R$ 0,00 · 0%
 * do estoque" ao lado de um estoque de sete dígitos: não é um número
 * incompleto, é um número errado.
 */
function Kpi({ label, value, hint, loading }: {
  label: string
  value: string
  hint: string
  loading?: boolean
}) {
  return (
    <div className="px-5 py-4">
      <p className="text-label text-muted-foreground">{label}</p>
      {loading ? (
        <>
          <div className="mt-1 h-6 w-32 animate-pulse rounded-xs bg-surface-inset" />
          <div className="mt-1.5 h-3 w-40 animate-pulse rounded-xs bg-surface-inset" />
        </>
      ) : (
        <>
          {/* Os quatro números saem na MESMA tinta. Um deles vinha pintado de
              acento, e enquanto o acento era um verde quase preto isso passava
              despercebido; com o azul vivo virou um número azul no meio de três
              pretos, dizendo "este aqui é diferente" sem que seja. Destaque em
              faixa comparativa é ruído: quem lê compara os quatro. */}
          <p className="font-data text-2xl font-bold leading-tight tabular-nums">
            {value}
          </p>
          <p className="mt-0.5 text-xs text-muted-foreground">{hint}</p>
        </>
      )}
    </div>
  )
}

/**
 * Célula da faixa de contagens — a fotografia do catálogo, não a decisão.
 *
 * Mais apertada que a `Kpi` de propósito: são fatos de apoio ("quantos SKUs",
 * "quantas peças a caminho") e, do mesmo tamanho dos quatro indicadores de
 * cima, competiriam com eles pela atenção de quem abre a tela para decidir.
 *
 * `alert` pinta em âmbar só quando há o que alertar. Cor fixa num rótulo de
 * ruptura vira decoração: fica vermelha com zero ruptura e ninguém mais olha.
 *
 * `tone` é outra coisa, e não é decoração: a faixa tem seis células do mesmo
 * tamanho e sem cor elas viravam uma régua indistinguível de cinza — para achar
 * "Vendas" era preciso LER as seis. O matiz é o endereço da célula, constante,
 * e por isso pode ser fixo: a categoria não muda com o dado. Fica só no
 * ladrilho do ícone, nunca no número, senão o valor passa a parecer status.
 */
const TONES = {
  violet: 'bg-violet-600 text-white',
  blue: 'bg-brand-600 text-white',
  cyan: 'bg-cyan-800 text-white',
  orange: 'bg-orange-600 text-white',
  teal: 'bg-brand-900 text-white',
} as const

function MiniKpi({ icon: Icon, label, value, hint, tone, alert, loading }: {
  icon: typeof Package
  label: string
  value: string
  hint: string
  tone: keyof typeof TONES
  alert?: boolean
  loading?: boolean
}) {
  return (
    <div className="flex items-center gap-3 bg-card px-4 py-3">
      <span
        className={`flex h-8 w-8 shrink-0 items-center justify-center rounded-sm ${
          alert ? 'bg-warning-200 text-warning-700' : TONES[tone]
        }`}
      >
        <Icon className="h-4 w-4" />
      </span>
      <div className="min-w-0">
        <p className="text-micro text-muted-foreground">{label}</p>
        {loading ? (
          <div className="mt-1 h-4 w-24 animate-pulse rounded-xs bg-surface-inset" />
        ) : (
          <p className="flex items-baseline gap-1.5">
            <span className="font-data text-base font-bold leading-tight tabular-nums">
              {value}
            </span>
            <span className="truncate text-xs text-muted-foreground">{hint}</span>
          </p>
        )}
      </div>
    </div>
  )
}

function Chip({ children }: { children: React.ReactNode }) {
  return (
    <span className="rounded-xs bg-surface-inset px-2 py-1 text-micro text-muted-foreground">
      {children}
    </span>
  )
}

/**
 * O Painel é de leitura. Recalcular mora em Pedido de compra, que é onde o
 * recálculo tem consequência — quem olha o retrato não deve poder trocá-lo por
 * baixo de quem está decidindo a compra.
 */
/**
 * Reparte o em-trânsito do item pelas datas previstas dos pedidos abertos.
 *
 * Quem manda no total é o snapshot, não a soma das linhas: é o snapshot que
 * alimenta o "posição atual" e o motor. As linhas só dizem QUANDO. Por isso as
 * quantidades são reescaladas para fechar com `inTransit` — se o ERP mudou um
 * pedido depois do snapshot, a curva continua partindo do mesmo número que o
 * resto da tela.
 *
 * Previsão vencida vira dia 0: "já era para ter chegado" desenha como chegada
 * imediata, que é a leitura menos otimista possível sem inventar atraso.
 */
function arrivalsOf(
  i: SnapshotItem,
  inTransit: number,
  transit: TransitIndex | undefined,
  referenceDate: string,
): { day: number; qty: number }[] | undefined {
  if (!(inTransit > 0) || !transit) return undefined
  const sku = i.sku ? i.sku.trim().toUpperCase() : null
  const lines = transit.byProduct.get(i.product_id) ?? (sku ? transit.bySku.get(sku) : undefined)
  if (!lines?.length) return undefined

  const total = lines.reduce((s, l) => s + l.qty, 0)
  if (!(total > 0)) return undefined
  const scale = inTransit / total

  const ref = Date.parse(`${referenceDate}T12:00:00`)
  const byDay = new Map<number, number>()
  for (const l of lines) {
    const day = l.eta
      ? Math.max(0, Math.round((Date.parse(`${l.eta}T12:00:00`) - ref) / 86_400_000))
      : 0
    byDay.set(day, (byDay.get(day) ?? 0) + l.qty * scale)
  }
  return [...byDay].map(([day, qty]) => ({ day, qty })).sort((a, b) => a.day - b.day)
}

/** Um item do snapshot vira uma série; `weight` decide a unidade do eixo. */
function toProjection(
  i: SnapshotItem,
  weight: number,
  transit: TransitIndex | undefined,
  referenceDate: string,
): ProjectionItem {
  const inTransit = num(i.in_transit)
  return {
    label: i.sku ?? undefined,
    stock: num(i.stock_total),
    inTransit,
    arrivals: arrivalsOf(i, inTransit, transit, referenceDate),
    weekly: num(i.weekly_blended),
    reorderPoint: num(i.reorder_point),
    safetyStock: num(i.safety_stock),
    maxStock: num(i.max_stock),
    suggestedQty: num(i.qty_to_order),
    weight,
  }
}

/**
 * O recorte da barra de filtros sobrevive ao recarregar — é preferência de
 * quem opera, não estado de navegação. Quem trabalha num CD só abre o Painel
 * todo dia para reescolher o mesmo depósito.
 *
 * A chave leva o id da empresa porque depósito É da empresa: um id guardado na
 * Triana não existe na All Out, e sem separar, trocar de empresa deixaria a
 * tela filtrada por um depósito inexistente — ou seja, zerada, sem explicação.
 */
const FILTERS_KEY = 'reporia:dashboard-filters'

type SavedFilters = {
  warehouseIds: string[]
  channel: string | null
  period: PeriodKey
}

const DEFAULT_FILTERS: SavedFilters = { warehouseIds: [], channel: null, period: 'month' }

/** Leitura defensiva: o que está no disco é entrada externa, não dado nosso. */
function loadFilters(companyId: string): SavedFilters {
  try {
    const raw = localStorage.getItem(`${FILTERS_KEY}:${companyId}`)
    if (!raw) return DEFAULT_FILTERS
    const p = JSON.parse(raw) as Partial<SavedFilters>
    return {
      warehouseIds: Array.isArray(p.warehouseIds)
        ? p.warehouseIds.filter((v): v is string => typeof v === 'string')
        : [],
      channel: typeof p.channel === 'string' ? p.channel : null,
      period: typeof p.period === 'string' && p.period in PERIOD_LABELS
        ? p.period as PeriodKey
        : DEFAULT_FILTERS.period,
    }
  } catch {
    return DEFAULT_FILTERS
  }
}

export default function Dashboard() {
  const { companyId } = useCompany()
  const { data: snapshot, isLoading } = useCurrentSnapshot()
  const { data: rawItems = [], isLoading: itemsLoading } = useSnapshotItems(snapshot?.id)
  const { data: params } = useReplenishmentParams()
  const { data: grades } = useProductGrades()
  const { data: demandProfile } = useDemandProfile()
  const { data: transit } = useInTransitEta()

  // '' = agregado da empresa; senão, product_id de um item em coleção.
  const [cycleProductId, setCycleProductId] = useState('')

  // O recorte da barra de filtros. Vive aqui e não no componente da barra
  // porque quem consome é o censo — a barra só edita.
  //
  // O estado carrega junto o id da empresa a que pertence, e a troca é feita
  // DURANTE o render em vez de num efeito: num efeito haveria um quadro em que
  // a tela da empresa nova já está montada com o filtro da anterior, e nesse
  // quadro o efeito de gravação salvaria o filtro errado no disco da empresa
  // nova.
  const [saved, setSaved] = useState<SavedFilters & { id: string | null }>(
    () => ({ id: null, ...DEFAULT_FILTERS }),
  )
  if (companyId && saved.id !== companyId) {
    setSaved({ id: companyId, ...loadFilters(companyId) })
  }

  useEffect(() => {
    if (!companyId || saved.id !== companyId) return
    const { warehouseIds, channel, period } = saved
    localStorage.setItem(
      `${FILTERS_KEY}:${companyId}`,
      JSON.stringify({ warehouseIds, channel, period }),
    )
  }, [companyId, saved])

  const { warehouseIds, channel, period } = saved
  const setPeriod = (p: PeriodKey) => setSaved((s) => ({ ...s, period: p }))
  const [from, to] = useMemo(() => periodRange(period), [period])
  const filters = useMemo(
    () => ({ warehouseIds, channel, from, to }),
    [warehouseIds, channel, from, to],
  )
  const { data: census, isLoading: censusLoading } = useDashboardCensus(filters)

  // Com depósito escolhido, as linhas do cálculo são reancoradas nele antes de
  // qualquer conta desta tela. Sem escolha, `scopedStock` não existe e as
  // linhas ficam como o motor as gravou.
  const { data: scopedStock, isLoading: stockLoading } = useStockByWarehouses(warehouseIds)
  const items = useMemo(
    () => (scopedStock ? scopeToWarehouses(rawItems, scopedStock) : rawItems),
    [rawItems, scopedStock],
  )
  const totals = useMemo(
    () => (scopedStock ? totalsOf(items) : snapshot?.totals ?? null),
    [items, scopedStock, snapshot],
  )
  const busy = itemsLoading || stockLoading

  /**
   * A listagem é por GRADE, não por variação.
   *
   * Uma regata em 3 cores × 4 tamanhos são 12 linhas no snapshot, todas com o
   * mesmo nome truncado na largura do seletor — "Regata Cropped Racer Marath…"
   * doze vezes, indistinguíveis. Quem escolhe está pensando na peça, não no
   * P azul.
   *
   * O motor continua por SKU: cada variação tem o seu PP e o seu Emáx, e a
   * simulação continua rodando uma por uma. A grade só junta as séries depois
   * — a mesma regra do agregado. Por isso a "ruptura" de uma grade é o dia em
   * que o ÚLTIMO tamanho sai, não o primeiro; está dito no subtítulo.
   *
   * Só entram itens com política calculada: fora de coleção não tem PP/Emáx
   * porque não vai ser recomprado.
   */
  const cycleGroups = useMemo(() => {
    const map = new Map<string, { label: string; items: SnapshotItem[] }>()
    for (const i of items) {
      if (!i.in_collection || i.max_stock == null) continue
      const grade = grades?.groupOf.get(i.product_id)
      const id = grade?.id ?? i.product_id
      const entry = map.get(id)
      if (entry) entry.items.push(i)
      else map.set(id, { label: `${grade?.sku ?? i.sku ?? '—'} · ${grade?.name ?? i.name ?? ''}`, items: [i] })
    }
    return map
  }, [items, grades])

  const cycleOptions = useMemo(() => [
    { value: '', label: 'Todos os produtos' },
    ...[...cycleGroups]
      .map(([value, g]) => ({
        value,
        label: g.items.length > 1 ? `${g.label} · ${g.items.length} variações` : g.label,
      }))
      .sort((a, b) => a.label.localeCompare(b.label)),
  ], [cycleGroups])

  const cycleItems = useMemo(
    () => (cycleProductId ? cycleGroups.get(cycleProductId)?.items ?? [] : []),
    [cycleGroups, cycleProductId],
  )

  // Resumo da grade escolhida — soma do que o gráfico vai simular, para o
  // subtítulo não descrever só a primeira variação.
  const cycle = useMemo(() => {
    if (cycleItems.length === 0) return null
    let daily = 0
    let position = 0
    for (const i of cycleItems) {
      daily += num(i.weekly_blended) / 7
      position += num(i.stock_total) + num(i.in_transit)
    }
    return { daily, position, count: cycleItems.length }
  }, [cycleItems])

  // Na grade a projeção é em peças (peso 1) — são todas a mesma peça, somar
  // unidade com unidade responde. No agregado da empresa cada item entra a
  // preço de venda, senão somar maçã com laranja não daria número nenhum.
  const refDate = snapshot?.reference_date ?? ''
  const projection = useMemo<ProjectionItem[]>(() => (
    cycle
      ? cycleItems.map((i) => toProjection(i, 1, transit, refDate))
      : items
        .filter((i) => i.in_collection)
        .map((i) => toProjection(i, num(i.sale_price), transit, refDate))
  ), [items, cycleItems, cycle, transit, refDate])

  const formatProjection = cycle
    ? (v: number) => `${formatInt(Math.round(v))} pç`
    : formatBRLCompact

  const idle = useMemo(() => analyseIdleCapital(items), [items])

  // Indicadores da faixa. Cobertura e compra olham só quem está em coleção:
  // item fora de coleção não é reposto, então diluiria os dois números com um
  // estoque que a política já desistiu de administrar.
  const kpis = useMemo(() => {
    let pieces = 0
    let weekly = 0
    let orderLines = 0
    let orderPieces = 0
    let orderCost = 0
    for (const i of items) {
      if (i.in_collection) {
        pieces += num(i.stock_total)
        weekly += num(i.weekly_blended)
      }
      if (i.should_order) {
        orderLines += 1
        orderPieces += num(i.qty_to_order)
        orderCost += num(i.qty_to_order) * num(i.cmv_used)
      }
    }
    return {
      coverageWeeks: weekly > 0 ? pieces / weekly : null,
      pieces,
      orderLines,
      orderPieces,
      orderCost,
    }
  }, [items])

  // A página inteira ainda não existe, então o bloco ganha a altura de uma
  // dobra: com a altura mínima padrão o rodapé subia para o meio da tela e
  // descia de volta quando o snapshot chegava.
  if (isLoading) return <LoadingBlock className="min-h-[60vh]" />

  if (!snapshot) {
    return (
      <Card>
        <CardHeader>
          <CardTitle className="text-base">Nenhum cálculo ainda</CardTitle>
          <CardDescription>
            Importe estoque e vendas e rode o motor. Todas as telas leem do mesmo cálculo, então
            elas nunca discordam entre si.
          </CardDescription>
        </CardHeader>
        <CardContent>
          <Button asChild>
            <Link to="/pedido">Ir para Pedido de compra</Link>
          </Button>
        </CardContent>
      </Card>
    )
  }

  const t = totals ?? snapshot.totals

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <h1 className="text-page-title">Painel</h1>
        <div className="flex flex-wrap items-center gap-1.5">
          <Chip>
            Cálculo de{' '}
            {new Date(snapshot.created_at).toLocaleString('pt-BR', {
              dateStyle: 'short', timeStyle: 'short',
            })}
          </Chip>
          <Chip>
            Referência {new Date(`${snapshot.reference_date}T12:00:00`).toLocaleDateString('pt-BR')}
          </Chip>
          <Chip>{snapshot.history_weeks} semanas de histórico</Chip>
          <Chip>Parâmetros v{snapshot.params_version}</Chip>
        </div>
      </div>

      {/* A faixa responde, em uma linha, as quatro perguntas que fazem alguém
          abrir esta tela: quanto tenho, quanto está preso, até quando dura e
          quanto vou gastar. O resto da página é a explicação delas. */}
      <Card className="overflow-hidden">
        <div className="grid divide-y divide-border sm:grid-cols-2 lg:grid-cols-4 lg:divide-x lg:divide-y-0">
          <Kpi
            label="Estoque a custo"
            value={formatBRL(t.current[1])}
            hint={`${formatBRL(t.current[0])} a preço de venda`}
            // Também espera as LINHAS, não só o saldo: com depósito escolhido
            // os agregados são refeitos sobre elas, e durante a paginação isso
            // dá "R$ 0,00" — um número errado, não um número incompleto.
            loading={busy}
          />
          <Kpi
            label="Capital parado"
            value={formatBRL(idle.idleCost)}
            hint={`${pctLabel(idle.idleShare)} do estoque · ${formatInt(idle.idlePieces)} pç`}
            loading={busy}
          />
          <Kpi
            label="Cobertura em coleção"
            value={kpis.coverageWeeks == null ? '—' : `${kpis.coverageWeeks.toFixed(1).replace('.', ',')} sem`}
            hint={`${formatInt(kpis.pieces)} pç ao ritmo de venda atual`}
            loading={busy}
          />
          <Kpi
            label="A comprar"
            value={formatBRL(kpis.orderCost)}
            hint={`${formatInt(kpis.orderLines)} ${kpis.orderLines === 1 ? 'linha' : 'linhas'} · ${formatInt(kpis.orderPieces)} pç`}
            loading={busy}
          />
        </div>
      </Card>

      {/* Faixa de censo: o tamanho do problema, não o dinheiro dele. A de cima
          responde "quanto custa"; esta responde "sobre quantos itens estamos
          falando".

          O DEPÓSITO atravessa a tela inteira: escolhido um, as linhas do
          cálculo são reancoradas nele e tudo que sai de saldo — os quatro
          números de cima, a projeção, o capital parado e as duas barras — passa
          a falar só dos depósitos escolhidos. Política (ponto de pedido,
          estoque máximo) não muda: é da empresa, não do depósito.

          CANAL e PERÍODO param aqui, e de propósito. Os dois mexem na demanda
          estimada, e demanda é conta do motor — refazê-la no navegador seria
          rodar um segundo motor, pior, em cima da mesma tela. */}
      <div className="space-y-2">
        <DashboardFilters
          value={filters}
          onChange={(f) => setSaved((s) => ({
            ...s, warehouseIds: f.warehouseIds, channel: f.channel,
          }))}
          period={period}
          onPeriodChange={setPeriod}
          channels={census?.channels ?? []}
        />
        <Card className="overflow-hidden">
          {/* `gap-px` sobre o fundo da borda em vez de `divide-x`: com seis
              células que reflowam de 1 para 6 colunas, `divide-*` desenha
              separador no lugar errado em cada breakpoint. */}
          <div className="grid gap-px bg-border sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-6">
            <MiniKpi
              icon={Package}
              tone="violet"
              label="Produtos"
              value={formatInt(census?.products ?? 0)}
              hint={`${formatInt(census?.in_collection ?? 0)} em coleção`}
              loading={censusLoading}
            />
            <MiniKpi
              icon={Boxes}
              tone="blue"
              label="Em estoque"
              value={formatInt(census?.pieces ?? 0)}
              hint={`${formatInt(census?.with_stock ?? 0)} produtos`}
              loading={censusLoading}
            />
            <MiniKpi
              icon={Wallet}
              tone="cyan"
              label="Valor do estoque"
              value={formatBRLCompact(census?.stock_cost ?? 0)}
              hint={`${formatBRLCompact(census?.stock_price ?? 0)} a preço de venda`}
              loading={censusLoading}
            />
            <MiniKpi
              icon={ShoppingCart}
              tone="orange"
              label="Vendas"
              value={formatInt(census?.sold_units ?? 0)}
              hint={formatBRLCompact(census?.sold_revenue ?? 0)}
              loading={censusLoading}
            />
            <MiniKpi
              icon={Receipt}
              tone="teal"
              label="Pedidos"
              value={formatInt(census?.orders ?? 0)}
              hint={census && census.orders > 0
                ? `${(census.order_lines / census.orders).toLocaleString('pt-BR', { maximumFractionDigits: 1 })} itens/ped`
                : 'nenhum no período'}
              loading={censusLoading}
            />
            <MiniKpi
              icon={AlertTriangle}
              tone="orange"
              label="Alertas"
              value={formatInt((census?.out_of_stock ?? 0) + (census?.below_safety ?? 0))}
              hint={`${formatInt(census?.out_of_stock ?? 0)} zerados · ${formatInt(census?.below_safety ?? 0)} baixos`}
              alert={((census?.out_of_stock ?? 0) + (census?.below_safety ?? 0)) > 0}
              loading={censusLoading}
            />
          </div>
        </Card>
        {/* Sem isto, "Vendas 844" é um número sem unidade de tempo. */}
        <p className="text-micro text-muted-foreground">
          Estoque e catálogo: posição de agora
          {warehouseIds.length === 0
            ? ', nos depósitos disponíveis para venda'
            : warehouseIds.length === 1
              ? ', no depósito escolhido'
              : `, nos ${warehouseIds.length} depósitos escolhidos`}.
          {' '}Vendas e pedidos: {PERIOD_LABELS[period].toLowerCase()}
          {channel ? ', no canal escolhido' : ', em todos os canais'}.
          {warehouseIds.length > 0
            ? ' Com depósito escolhido, o Painel inteiro passa a falar dele — inclusive'
              + ' "A comprar", que vira a compra necessária para abastecer só esses'
              + ' depósitos. Pedido de compra continua somando a empresa toda.'
            : ' Canal e período recortam venda e pedidos; o estoque não tem canal nem mês.'}
        </p>
      </div>

      <div>
        <Card>
          <CardHeader className="pb-2">
            <div className="flex flex-wrap items-start justify-between gap-3">
              <div>
                <CardTitle className="text-card-title">
                  {cycle ? 'Cobertura e projeção de estoque' : 'Projeção de estoque'}
                </CardTitle>
                <CardDescription>
                  {cycle
                    ? `Venda média de ${cycle.daily.toLocaleString('pt-BR', { maximumFractionDigits: 1 })} pç/dia · `
                      + `posição atual: ${formatInt(cycle.position)} pç`
                      + (cycle.count > 1
                        ? ` · soma de ${cycle.count} variações, cada uma com a sua política — a linha é a soma, mas as datas são do primeiro tamanho a faltar`
                        : '')
                    : 'Cada item em coleção simulado separado e somado a preço de venda. No agregado não há dente de serra: os ciclos estão fora de fase e o que sobra é o patamar.'}
                </CardDescription>
              </div>
              <SearchableSelect
                value={cycleProductId}
                onValueChange={setCycleProductId}
                options={cycleOptions}
                placeholder="Todos os produtos"
                searchPlaceholder="SKU ou nome…"
                triggerClassName="w-56"
                aria-label="Filtrar produto da projeção de estoque"
              />
            </div>
          </CardHeader>
          <CardContent>
            {/* Sem linha nenhuma a simulação desenha uma régua de R$ 1 e um
                rodapé de "0 de 0 SKUs" — um gráfico vazio se lê como quebrado,
                não como carregando. */}
            {busy ? (
              <div className="h-[360px] animate-pulse rounded-sm bg-surface-inset" />
            ) : (
              <StockProjectionChart
                items={projection}
                referenceDate={snapshot.reference_date}
                leadTimeDays={params?.lead_time_days ?? 80}
                formatValue={formatProjection}
                granularity={cycle ? 'sku' : 'portfolio'}
                dailyProfile={demandProfile?.weights}
              />
            )}
          </CardContent>
        </Card>
      </div>

      <IdleCapitalCard report={idle} loading={busy} />

      {/* Daqui para baixo a tela deixa de falar de quanto e passa a falar de
          QUAL. A curva sai das mesmas linhas de cima — já reancoradas no
          depósito escolhido. Os três de venda (cores, conjunto, upsell) saem de
          consultas próprias e obedecem a canal e período, não a depósito: o
          pedido não guarda de qual prateleira a peça saiu. */}

      {/* Largura inteira: a categoria é um caminho de três níveis, e o nome do
          filho ("Upper → Regata Compressão") não cabe em meia tela sem virar
          reticências — que é justamente onde ele deixa de distinguir. */}
      <SalesByCategoryCard filters={filters} periodLabel={PERIOD_LABELS[period]} />

      <div className="grid gap-4 lg:grid-cols-2">
        <AbcSummaryCard
          items={items}
          leadTimeDays={params?.lead_time_days ?? 80}
          loading={busy}
        />
        <TopColorsCard filters={filters} periodLabel={PERIOD_LABELS[period]} />
      </div>

      <div className="grid gap-4 lg:grid-cols-2">
        <SoldTogetherCard filters={filters} />
        <UpsellCard filters={filters} />
      </div>
    </div>
  )
}
