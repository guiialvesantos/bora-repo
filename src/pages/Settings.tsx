import { useEffect, useMemo, useState } from 'react'
import { toast } from 'sonner'
import { History, Loader2, RotateCcw, Save } from 'lucide-react'
import {
  usePreview, usePublishParams, useParamsHistory, useReplenishmentParams,
} from '@/hooks/useReplenishmentParams'
import { useCurrentSnapshot } from '@/hooks/useCurrentSnapshot'
import { formatBRL, formatInt } from '@/lib/money'
import { num } from '@/lib/replenishment-types'
import type {
  DemandModel, DemandWindowBasis, PreviewResult, ReplenishmentParams,
} from '@/lib/replenishment-types'
import { Button } from '@/components/ui/button'
import { Badge } from '@/components/ui/badge'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Switch } from '@/components/ui/switch'
import { Textarea } from '@/components/ui/textarea'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import {
  Table, TableBody, TableCell, TableHead, TableHeader, TableRow,
} from '@/components/ui/table'

/**
 * Os campos que o formulário edita. O resto de `replenishment_params`
 * (`today_override`, `sales_cutoff_on`) fica fora de propósito: existe só para
 * o harness congelar o relógio, e um campo de data escondido numa tela de
 * configuração é o tipo de coisa que alguém preenche sem querer e leva meses
 * para alguém notar por que o número parou de mudar.
 */
interface Draft {
  demand_model: DemandModel
  demand_window_basis: DemandWindowBasis
  lead_time_days: string
  order_cycle_weeks: string
  cmv_pct: string
  service_level_a: string
  service_level_b: string
  service_level_c: string
  abc_cut_a: string
  abc_cut_b: string
  recent_window_days: string
}

function toDraft(p: ReplenishmentParams): Draft {
  return {
    demand_model: p.demand_model,
    demand_window_basis: p.demand_window_basis,
    lead_time_days: String(p.lead_time_days),
    order_cycle_weeks: String(num(p.order_cycle_weeks)),
    cmv_pct: String(num(p.cmv_pct) * 100),
    service_level_a: String(num(p.service_level_a) * 100),
    service_level_b: String(num(p.service_level_b) * 100),
    service_level_c: String(num(p.service_level_c) * 100),
    abc_cut_a: String(num(p.abc_cut_a) * 100),
    abc_cut_b: String(num(p.abc_cut_b) * 100),
    recent_window_days: String(p.recent_window_days),
  }
}

/**
 * O patch só leva as chaves editáveis; o `publish` preenche o resto com a
 * versão corrente. As correções da planilha (âncora da janela, ES fora de
 * coleção, σ calculado, SKU normalizado) foram viradas de vez na v2 e saíram
 * da UI — o modo legado sobrevive no banco só para o harness de paridade.
 */
function toPatch(d: Draft): Record<string, unknown> {
  const n = (v: string) => Number(v.replace(',', '.'))
  return {
    demand_model: d.demand_model,
    demand_window_basis: d.demand_window_basis,
    lead_time_days: Math.round(n(d.lead_time_days)),
    order_cycle_weeks: n(d.order_cycle_weeks),
    cmv_pct: n(d.cmv_pct) / 100,
    service_level_a: n(d.service_level_a) / 100,
    service_level_b: n(d.service_level_b) / 100,
    service_level_c: n(d.service_level_c) / 100,
    abc_cut_a: n(d.abc_cut_a) / 100,
    abc_cut_b: n(d.abc_cut_b) / 100,
    recent_window_days: Math.round(n(d.recent_window_days)),
  }
}

/**
 * Cada modelo carrega o seu defeito conhecido escrito do lado. Os dois têm um,
 * e é assimétrico: o legado depende da idade do produto no catálogo, o 90/180
 * depende de como o divisor das janelas está configurado. Quem escolhe precisa
 * ver os dois — e a ressalva do 90/180 muda conforme o divisor, por isso é
 * função e não texto fixo.
 */
const DEMAND_MODELS: {
  value: DemandModel
  label: string
  formula: (b: DemandWindowBasis) => string
  caveat: (b: DemandWindowBasis) => string
}[] = [
  {
    value: 'blended_legacy',
    label: 'Planilha (longo prazo + janela recente)',
    formula: () => '(vendas ÷ semanas de catálogo + janela recente) ÷ 2',
    caveat: () => 'Acompanha lançamento bem. Mas arrasta a história inteira do produto, '
      + 'então demora a reagir quando a venda muda de patamar.',
  },
  {
    value: 'weighted_90_180',
    label: 'Ponderado 90/180 dias',
    formula: (b) => (b === 'effective'
      ? '0,7 × (90d ÷ semanas vividas, até 13) + 0,3 × (180d ÷ semanas vividas, até 26)'
      : '0,7 × (90d ÷ 13 sem) + 0,3 × (180d ÷ 26 sem)'),
    caveat: (b) => (b === 'effective'
      ? 'Reage rápido e não depende da idade do catálogo. Com semanas efetivas ligadas, '
        + 'lançamento deixa de ser subdimensionado — em troca, produto com pouquíssima '
        + 'venda projeta a partir de pouquíssima evidência.'
      : 'Reage rápido e não depende da idade do catálogo. Mas subdimensiona produto '
        + 'com menos de 26 semanas de vida, porque divide por janela que ele não viveu.'),
  },
]

function StatRow({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex items-baseline justify-between gap-4 text-sm">
      <span className="text-muted-foreground">{label}</span>
      <span className="font-medium tabular-nums">{value}</span>
    </div>
  )
}

export default function Settings() {
  const { data: params, isLoading } = useReplenishmentParams()
  const { data: history = [] } = useParamsHistory()
  const { data: snapshot } = useCurrentSnapshot()
  const preview = usePreview()
  const publish = usePublishParams()

  const [draft, setDraft] = useState<Draft | null>(null)
  const [note, setNote] = useState('')
  const [sim, setSim] = useState<PreviewResult | null>(null)

  useEffect(() => { if (params && !draft) setDraft(toDraft(params)) }, [params, draft])

  const dirty = useMemo(
    () => !!params && !!draft && JSON.stringify(draft) !== JSON.stringify(toDraft(params)),
    [params, draft])

  // Simular é barato — `replenishment_preview` devolve só os agregados, sem as
  // 600 linhas — mas não é de graça. Meio segundo de silêncio depois da última
  // tecla é o suficiente para não disparar uma chamada por dígito.
  useEffect(() => {
    if (!draft || !dirty) { setSim(null); return }
    const t = setTimeout(() => {
      preview.mutate(toPatch(draft), { onSuccess: setSim, onError: () => setSim(null) })
    }, 500)
    return () => clearTimeout(t)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [draft, dirty])

  if (isLoading || !draft || !params) {
    return <p className="text-sm text-muted-foreground">Carregando…</p>
  }

  const set = <K extends keyof Draft>(k: K, v: Draft[K]) => setDraft({ ...draft, [k]: v })

  function save() {
    if (!draft) return
    publish.mutate(
      { patch: toPatch(draft), note: note.trim() || undefined },
      {
        onSuccess: () => { setNote(''); setSim(null); toast.success('Parâmetros publicados e recalculados.') },
        onError: (e) => toast.error(e.message),
      },
    )
  }

  const before = snapshot?.totals

  // A janela recente alimenta `weekly_recent`, e `weekly_recent` só entra na
  // demanda no ramo `blended_legacy`. Lê do rascunho, e não da versão
  // publicada: trocar o modelo acende e apaga o campo na hora, antes de
  // publicar, e a relação entre os dois fica óbvia sem ninguém explicar.
  const usesRecentWindow = draft.demand_model === 'blended_legacy'

  const numField = (
    k: keyof Draft, label: string, suffix?: string, opts?: { hint?: string },
  ) => (
    <div className="space-y-1.5">
      <Label htmlFor={k}>{label}</Label>
      <div className="flex items-center gap-2">
        <Input
          id={k}
          inputMode="decimal"
          value={String(draft[k])}
          onChange={(e) => set(k, e.target.value as Draft[typeof k])}
        />
        {suffix && <span className="text-sm text-muted-foreground">{suffix}</span>}
      </div>
      {opts?.hint && <p className="text-xs text-muted-foreground">{opts.hint}</p>}
    </div>
  )

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-start justify-between gap-4">
        <div>
          {/* Sem `h1`: o título e as abas são do `SettingsHub`. */}
          <p className="max-w-2xl text-sm text-muted-foreground">
            Parâmetro não se edita: publica-se uma versão nova. A versão {params.version} continua
            no banco, e o snapshot que ela gerou continua explicável.
          </p>
        </div>
        <div className="flex gap-2">
          {dirty && (
            <Button variant="ghost" onClick={() => { setDraft(toDraft(params)); setSim(null) }}>
              <RotateCcw className="mr-2 h-4 w-4" /> Descartar
            </Button>
          )}
          <Button onClick={save} disabled={!dirty || publish.isPending}>
            {publish.isPending
              ? <Loader2 className="mr-2 h-4 w-4 animate-spin" />
              : <Save className="mr-2 h-4 w-4" />}
            Publicar v{params.version + 1} e recalcular
          </Button>
        </div>
      </div>

      <div className="grid gap-6 lg:grid-cols-[2fr_1fr]">
        <div className="space-y-6">
          <Card>
            <CardHeader>
              <CardTitle className="text-base">Modelo de demanda</CardTitle>
              <CardDescription>
                De onde sai a venda semanal que dimensiona estoque de segurança, ponto de pedido e
                estoque máximo. Trocar aqui simula na hora, ao lado — só publica se você mandar.
              </CardDescription>
            </CardHeader>
            <CardContent className="grid gap-3 sm:grid-cols-2">
              {DEMAND_MODELS.map((m) => (
                <button
                  key={m.value}
                  type="button"
                  onClick={() => set('demand_model', m.value)}
                  className={[
                    'rounded-sm border p-3 text-left transition-ui',
                    draft.demand_model === m.value
                      ? 'border-brand-600 bg-brand-100'
                      : 'border-border hover:border-border-strong hover:bg-surface-subtle',
                  ].join(' ')}
                >
                  <span className="block text-sm font-medium">{m.label}</span>
                  <span className="mt-0.5 block font-mono text-xs text-muted-foreground">
                    {m.formula(draft.demand_window_basis)}
                  </span>
                  <span className="mt-1.5 block text-xs text-muted-foreground">
                    {m.caveat(draft.demand_window_basis)}
                  </span>
                </button>
              ))}

              {/* Só aparece sob o 90/180 porque é o divisor DELE. O legado já
                  divide pela idade do catálogo — para ele a chave não existe. */}
              {draft.demand_model === 'weighted_90_180' && (
                <label className="flex cursor-pointer gap-3 rounded-lg border border-border p-3 sm:col-span-2">
                  <Switch
                    checked={draft.demand_window_basis === 'effective'}
                    onCheckedChange={(v) => set('demand_window_basis', v ? 'effective' : 'fixed')}
                  />
                  <span className="block">
                    <span className="block text-sm font-medium">
                      Semanas efetivas para produto novo
                    </span>
                    <span className="mt-0.5 block text-xs text-muted-foreground">
                      Divide pela idade do SKU quando ela é menor que a janela. Sem isso, um
                      produto com 7 semanas de vida é dividido por 26 e ganha 19 semanas de
                      venda zero que nunca existiram — a taxa sai por volta de um terço da
                      real, e o ponto de pedido junto. Piso de 4 semanas, para lançamento de
                      três dias não projetar demanda absurda.
                    </span>
                  </span>
                </label>
              )}
              {/* A janela é parâmetro DO modelo legado, não da curva ABC — onde
                  ela morava por acidente de layout. Aqui ela aparece e some
                  junto com o modelo que a usa, e ninguém mais procura o efeito
                  de um campo que não está em conta nenhuma. */}
              {usesRecentWindow && (
                <div className="sm:col-span-2">
                  {numField('recent_window_days', 'Janela recente', 'dias', {
                    hint: 'A metade de peso curto da fórmula acima: vendas deste período '
                      + 'divididas pelo número de semanas dele.',
                  })}
                </div>
              )}
            </CardContent>
          </Card>

          <Card>
            <CardHeader>
              <CardTitle className="text-base">Política de compra</CardTitle>
              <CardDescription>
                Prazo e ciclo são o que dimensiona o estoque. Os dois entram em semanas no
                cálculo; o prazo fica em dias porque é assim que o fornecedor fala.
              </CardDescription>
            </CardHeader>
            <CardContent className="grid gap-4 sm:grid-cols-3">
              {numField('lead_time_days', 'Prazo de entrega', 'dias')}
              {numField('order_cycle_weeks', 'Ciclo de pedido', 'semanas')}
              {numField('cmv_pct', 'CMV quando não informado', '%')}
            </CardContent>
          </Card>

          <Card>
            <CardHeader>
              <CardTitle className="text-base">Níveis de serviço</CardTitle>
              <CardDescription>
                A probabilidade de não faltar dentro do prazo de entrega. Subir o nível do A é a
                alavanca mais cara que existe aqui: de 95% para 99% o Z quase dobra, e o estoque
                de segurança vai junto.
              </CardDescription>
            </CardHeader>
            <CardContent className="grid gap-4 sm:grid-cols-3">
              {numField('service_level_a', 'Classe A', '%')}
              {numField('service_level_b', 'Classe B', '%')}
              {numField('service_level_c', 'Classe C', '%')}
            </CardContent>
          </Card>

          <Card>
            <CardHeader>
              <CardTitle className="text-base">Curva ABC</CardTitle>
              <CardDescription>
                Os cortes são no faturamento acumulado dos itens em coleção: A vai até o primeiro
                corte, B até o segundo, C é o resto.
              </CardDescription>
            </CardHeader>
            <CardContent className="grid gap-4 sm:grid-cols-2">
              {numField('abc_cut_a', 'Corte A até', '% acum.')}
              {numField('abc_cut_b', 'Corte B até', '% acum.')}
            </CardContent>
          </Card>

          <Card>
            <CardHeader>
              <CardTitle className="text-base">Nota da versão</CardTitle>
              <CardDescription>
                Fica gravada junto. Daqui a seis meses, quando alguém perguntar por que o pedido
                dobrou numa semana, é isto que responde.
              </CardDescription>
            </CardHeader>
            <CardContent>
              <Textarea
                rows={2}
                value={note}
                onChange={(e) => setNote(e.target.value)}
                placeholder="Ex.: virada da âncora da janela de 28 dias, combinado com a Triana em 11/09."
              />
            </CardContent>
          </Card>
        </div>

        <div className="space-y-6">
          <Card className={dirty ? 'border-brand-600' : undefined}>
            <CardHeader className="pb-3">
              <CardTitle className="text-base">Simulação</CardTitle>
              <CardDescription>
                {dirty
                  ? 'Nada foi gravado ainda. Estes são os números que a publicação produziria.'
                  : 'Mexa num campo para ver o efeito antes de publicar.'}
              </CardDescription>
            </CardHeader>
            <CardContent className="space-y-3">
              {!dirty ? (
                <p className="text-sm text-muted-foreground">
                  Sem alterações pendentes.
                </p>
              ) : preview.isPending && !sim ? (
                <p className="flex items-center gap-2 text-sm text-muted-foreground">
                  <Loader2 className="h-4 w-4 animate-spin" /> Calculando…
                </p>
              ) : sim ? (
                <>
                  <StatRow label="Linhas no pedido" value={formatInt(sim.order_lines)} />
                  <StatRow label="Peças a pedir" value={formatInt(num(sim.order_pieces))} />
                  <StatRow label="Em coleção" value={formatInt(sim.in_collection)} />
                  <StatRow
                    label="Curva ABC"
                    value={`${sim.abc_a} / ${sim.abc_b} / ${sim.abc_c}`}
                  />
                  <div className="border-t border-border pt-3">
                    <StatRow label="Segurança (custo)" value={formatBRL(sim.totals.safety[1])} />
                    {before && (
                      <p className="text-right text-xs text-muted-foreground tabular-nums">
                        era {formatBRL(before.safety[1])}
                      </p>
                    )}
                  </div>
                  <div>
                    <StatRow label="Máximo (custo)" value={formatBRL(sim.totals.max_active[1])} />
                    {before && (
                      <p className="text-right text-xs text-muted-foreground tabular-nums">
                        era {formatBRL(before.max_active[1])}
                      </p>
                    )}
                  </div>
                  {sim.low_confidence > 0 && (
                    <p className="pt-2 text-xs text-warning-700">
                      {formatInt(sim.low_confidence)} itens com menos de 4 semanas de histórico —
                      o σ deles é um chute com cara de número.
                    </p>
                  )}
                </>
              ) : (
                <p className="text-sm text-muted-foreground">
                  Não foi possível simular com estes valores.
                </p>
              )}
            </CardContent>
          </Card>

          <Card>
            <CardHeader className="pb-3">
              <CardTitle className="flex items-center gap-2 text-base">
                <History className="h-4 w-4" /> Histórico
              </CardTitle>
            </CardHeader>
            <CardContent>
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead className="w-12">v</TableHead>
                    <TableHead>Quando</TableHead>
                    <TableHead>Nota</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {history.map((h) => (
                    <TableRow key={h.id}>
                      <TableCell className="tabular-nums">
                        {h.is_current
                          ? <Badge variant="outline" className="font-mono">{h.version}</Badge>
                          : h.version}
                      </TableCell>
                      <TableCell className="whitespace-nowrap text-xs tabular-nums">
                        {new Date(h.created_at).toLocaleDateString('pt-BR')}
                      </TableCell>
                      <TableCell className="text-xs text-muted-foreground">
                        {h.note ?? '—'}
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </CardContent>
          </Card>
        </div>
      </div>
    </div>
  )
}
