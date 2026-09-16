import { CalendarDays, Check, ChevronDown, Plug, Store, Warehouse } from 'lucide-react'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu'
import { useConnections, useWarehouses } from '@/hooks/useDashboardCensus'
import type { CensusFilters } from '@/hooks/useDashboardCensus'
import { PERIOD_LABELS } from '@/lib/dashboard-period'
import type { PeriodKey } from '@/lib/dashboard-period'

const CHANNEL_LABELS: Record<string, string> = {
  olist: 'Olist (Tiny)',
  site: 'Site',
  loja: 'Loja física',
  manual: 'Lançamento manual',
}

type Option = { value: string | null; label: string; hint?: string }

const pillClass = (active: boolean) =>
  `flex h-8 items-center gap-1.5 rounded-full border px-3 text-xs transition-colors
   disabled:cursor-default disabled:opacity-60
   ${active
    ? 'border-brand-600 bg-brand-100 font-medium text-brand-600'
    : 'border-border bg-card text-muted-foreground hover:bg-surface-inset'}`

function Pill({ icon: Icon, value, options, onChange, disabled, title }: {
  icon: typeof Store
  value: string | null
  options: Option[]
  onChange: (v: string | null) => void
  disabled?: boolean
  title?: string
}) {
  const current = options.find((o) => o.value === value) ?? options[0]
  const active = value !== null

  return (
    <DropdownMenu>
      <DropdownMenuTrigger disabled={disabled} title={title} className={pillClass(active)}>
        <Icon className="h-3.5 w-3.5 shrink-0" />
        <span className="max-w-40 truncate">{current?.label}</span>
        {!disabled && <ChevronDown className="h-3.5 w-3.5 shrink-0 opacity-60" />}
      </DropdownMenuTrigger>
      <DropdownMenuContent align="start" className="max-h-80 overflow-y-auto">
        {options.map((o) => (
          <DropdownMenuItem
            key={o.value ?? '__all'}
            onSelect={() => onChange(o.value)}
            className="gap-2 text-xs"
          >
            <Check className={`h-3.5 w-3.5 shrink-0 ${o.value === value ? '' : 'opacity-0'}`} />
            <span className="flex-1">{o.label}</span>
            {o.hint && <span className="text-micro text-muted-foreground">{o.hint}</span>}
          </DropdownMenuItem>
        ))}
      </DropdownMenuContent>
    </DropdownMenu>
  )
}

/**
 * A pílula de depósitos — a única que aceita mais de uma escolha.
 *
 * `onSelect` com `preventDefault` porque o Radix fecha o menu a cada item
 * escolhido, e num filtro de marcar/desmarcar isso obriga a reabrir o menu para
 * cada depósito. Aqui o menu só fecha por fora.
 *
 * A primeira linha ("Todos") não é um item a mais na lista, é o RESET: marcar
 * todos um a um dá o mesmo conjunto mas não a mesma coisa — "todos" é o padrão
 * do motor (`include_in_available`), que inclui automaticamente um depósito
 * criado amanhã.
 */
function MultiPill({ icon: Icon, values, options, onChange, title, allLabel }: {
  icon: typeof Store
  values: string[]
  options: Option[]
  onChange: (v: string[]) => void
  title?: string
  allLabel: string
}) {
  const label = values.length === 0
    ? allLabel
    : values.length === 1
      ? options.find((o) => o.value === values[0])?.label ?? '1 selecionado'
      : `${values.length} selecionados`

  return (
    <DropdownMenu>
      <DropdownMenuTrigger title={title} className={pillClass(values.length > 0)}>
        <Icon className="h-3.5 w-3.5 shrink-0" />
        <span className="max-w-40 truncate">{label}</span>
        <ChevronDown className="h-3.5 w-3.5 shrink-0 opacity-60" />
      </DropdownMenuTrigger>
      <DropdownMenuContent align="start" className="max-h-80 overflow-y-auto">
        <DropdownMenuItem
          onSelect={(e) => { e.preventDefault(); onChange([]) }}
          className="gap-2 text-xs"
        >
          <Check className={`h-3.5 w-3.5 shrink-0 ${values.length === 0 ? '' : 'opacity-0'}`} />
          <span className="flex-1">{allLabel}</span>
          <span className="text-micro text-muted-foreground">disponíveis</span>
        </DropdownMenuItem>
        {options.map((o) => {
          const on = o.value != null && values.includes(o.value)
          return (
            <DropdownMenuItem
              key={o.value}
              onSelect={(e) => {
                e.preventDefault()
                if (o.value == null) return
                onChange(on ? values.filter((v) => v !== o.value) : [...values, o.value])
              }}
              className="gap-2 text-xs"
            >
              <Check className={`h-3.5 w-3.5 shrink-0 ${on ? '' : 'opacity-0'}`} />
              <span className="flex-1">{o.label}</span>
              {o.hint && <span className="text-micro text-muted-foreground">{o.hint}</span>}
            </DropdownMenuItem>
          )
        })}
      </DropdownMenuContent>
    </DropdownMenu>
  )
}

/**
 * A barra de recorte do Painel.
 *
 * Três dos quatro filtros mexem no censo. O de integração NÃO: nem `products`
 * nem `sales_orders` gravam por qual conexão a linha entrou, então escolher
 * uma não filtraria coisa alguma. Ele fica desabilitado, nomeando a conexão
 * viva — um controle honesto sobre o que existe é melhor do que um que parece
 * clicável e não faz nada.
 */
export function DashboardFilters({ value, onChange, period, onPeriodChange, channels }: {
  value: CensusFilters
  onChange: (v: CensusFilters) => void
  period: PeriodKey
  onPeriodChange: (p: PeriodKey) => void
  channels: string[]
}) {
  const { data: warehouses = [] } = useWarehouses()
  const { data: connections = [] } = useConnections()

  const live = connections.filter((c) => c.status === 'connected')
  const connLabel = live.length === 0
    ? 'Sem integração'
    : live.length === 1
      ? `Tiny ${live[0].provider === 'tiny_v3' ? 'v3' : 'v2'}`
      : 'Todas integrações'

  return (
    <div className="flex flex-wrap items-center gap-1.5">
      <Pill
        icon={Plug}
        value={null}
        options={[{ value: null, label: connLabel }]}
        onChange={() => {}}
        disabled
        title={
          'O recorte por integração ainda não existe: nem os produtos nem os pedidos '
          + 'guardam por qual conexão entraram. Hoje o Painel mostra tudo da empresa.'
        }
      />
      <Pill
        icon={Store}
        value={value.channel}
        options={[
          { value: null, label: 'Todos os canais' },
          ...channels.map((c) => ({ value: c, label: CHANNEL_LABELS[c] ?? c })),
        ]}
        onChange={(channel) => onChange({ ...value, channel })}
        disabled={channels.length < 2}
        title={channels.length < 2
          ? 'Só há um canal de venda nesta empresa.'
          : 'Recorta venda e pedidos por canal. Não muda o estoque.'}
      />
      <MultiPill
        icon={Warehouse}
        values={value.warehouseIds}
        allLabel="Todos os depósitos"
        options={warehouses.map((w) => ({
          value: w.id,
          label: w.name,
          hint: w.include_in_available ? undefined : 'fora do disponível',
        }))}
        onChange={(warehouseIds) => onChange({ ...value, warehouseIds })}
        title={
          'Sem escolha, soma só os depósitos marcados como disponíveis para venda — '
          + 'a mesma definição que o motor usa. Com escolha, o Painel inteiro passa a '
          + 'falar só desses depósitos. Não muda a venda.'
        }
      />
      <Pill
        icon={CalendarDays}
        value={period === 'all' ? null : period}
        options={(Object.keys(PERIOD_LABELS) as PeriodKey[]).map((k) => ({
          value: k === 'all' ? null : k,
          label: PERIOD_LABELS[k],
        }))}
        onChange={(p) => onPeriodChange((p as PeriodKey | null) ?? 'all')}
        title="Recorta venda e pedidos. O estoque é sempre a posição de agora."
      />
    </div>
  )
}
