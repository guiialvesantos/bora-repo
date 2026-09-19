import { useEffect, useMemo, useRef, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { Download, PackageX, Printer, Search } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { Input } from '@/components/ui/input'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table'
import { ProductCell } from '@/components/ProductThumb'
import { CardTitleRow } from '@/components/InfoHint'
import { PrintHeader } from '@/components/PrintHeader'
import { printDocument } from '@/lib/print'
import { useCompany } from '@/contexts/CompanyContext'
import { useStalled } from '@/hooks/useStalled'
import { analyseStalled, ACTION_BY_KEY, STALLED_ACTIONS } from '@/lib/stalled'
import type { StalledAction } from '@/lib/stalled'
import { formatBRL, formatInt } from '@/lib/money'
import { num } from '@/lib/replenishment-types'

/**
 * Encalhados — o estoque que parou de sair, por produto.
 *
 * O "Capital parado" do Painel responde quanto e em que faixa. Esta tela
 * responde qual, há quanto tempo e o que fazer, que é a pergunta seguinte.
 *
 * Sai do catálogo AO VIVO, não do último snapshot, e isso é de propósito: o
 * motor não calcula linha para produto inativo no ERP, então peça desativada
 * com saldo não aparece em faixa nenhuma do Painel — na All Out são 52 SKUs e
 * quase R$ 90 mil de estoque que hoje ninguém vê. Estoque desativado continua
 * sendo dinheiro parado; desativar o cadastro não esvazia a prateleira.
 */

const WINDOWS = [30, 60, 90, 180, 365] as const
const WINDOW_LABEL: Record<number, string> = {
  30: '30 dias', 60: '60 dias', 90: '90 dias', 180: '180 dias', 365: '1 ano',
}

const PAGE = 60

const TONE: Record<'bad' | 'warn' | 'muted', string> = {
  bad: 'bg-danger-soft text-destructive',
  warn: 'bg-warning-100 text-warning-800',
  muted: 'bg-surface-inset text-muted-foreground',
}

function fmtDate(iso: string | null | undefined): string {
  if (!iso) return '—'
  const [y, m, d] = iso.slice(0, 10).split('-')
  return `${d}/${m}/${y}`
}

/** CSV com `;` e vírgula decimal — o que o Excel em pt-BR abre sem perguntar. */
function toCsv(rows: (string | number)[][]) {
  return rows
    .map((r) => r.map((c) => {
      const s = typeof c === 'number' ? c.toFixed(2).replace('.', ',') : c
      return /[;"\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s
    }).join(';'))
    .join('\r\n')
}

export default function StalledProducts() {
  const { data, isLoading, isError, error } = useStalled()
  const { company } = useCompany()
  const navigate = useNavigate()

  const [minDays, setMinDays] = useState<number>(90)
  const [action, setAction] = useState<StalledAction | null>(null)
  const [q, setQ] = useState('')
  const [shown, setShown] = useState(PAGE)
  const wantsPrint = useRef(false)

  const report = useMemo(
    () => analyseStalled(data?.rows ?? [], minDays, num(data?.stock_cost)),
    [data, minDays],
  )

  const filtered = useMemo(() => {
    const terms = q.trim().toLowerCase().split(/\s+/).filter(Boolean)
    return report.items.filter((it) => {
      if (action && it.action !== action) return false
      if (terms.length === 0) return true
      const hay = `${it.row.sku ?? ''} ${it.row.name ?? ''} ${it.row.category ?? ''}`.toLowerCase()
      return terms.every((t) => hay.includes(t))
    })
  }, [report.items, action, q])

  const slug = `borarepo-encalhados-${minDays}d-${data?.reference_date ?? 'stock'}`

  /**
   * A tabela é paginada em 60 linhas, e o papel não tem "Mostrar mais": imprimir
   * direto entregaria um documento truncado sem avisar ninguém — o pior tipo de
   * defeito, porque o total no topo continuaria certo e só as linhas sumiriam.
   * Então a impressão abre a lista inteira primeiro e só chama o navegador
   * depois que o React comprometeu essas linhas no DOM.
   *
   * O pedido de impressão é um ref, não estado: ele não desenha nada e só existe
   * entre um render e o seguinte. E quando a lista JÁ está inteira na tela não há
   * render nenhum para esperar — sem o atalho, o botão não faria nada em toda
   * lista com menos de 60 linhas.
   */
  useEffect(() => {
    if (!wantsPrint.current) return
    wantsPrint.current = false
    printDocument(slug)
  }, [shown, slug])

  function printReport() {
    if (shown >= filtered.length) {
      printDocument(slug)
      return
    }
    wantsPrint.current = true
    setShown(filtered.length)
  }

  function exportCsv() {
    const header = ['SKU', 'Produto', 'Categoria', 'Peças', 'Custo unitário', 'Capital parado',
                    'Última venda', 'Dias parado', 'Vendas na vida', 'Fora de coleção',
                    'Inativo no ERP', 'Recomendação']
    const body = filtered.map((it) => [
      it.row.sku ?? '', it.row.name ?? '', it.row.category ?? '',
      it.stock, num(it.row.cmv), it.cost,
      it.row.last_sale ?? 'nunca', it.days ?? '', num(it.row.total_units),
      it.row.discontinued ? 'sim' : 'não',
      it.row.is_active ? 'não' : 'sim',
      ACTION_BY_KEY[it.action].label,
    ])
    const blob = new Blob([`\uFEFF${toCsv([header, ...body])}`], { type: 'text/csv;charset=utf-8' })
    const a = document.createElement('a')
    a.href = URL.createObjectURL(blob)
    a.download = `${slug}.csv`
    a.click()
    URL.revokeObjectURL(a.href)
  }

  if (isError) {
    return (
      <Card>
        <CardContent className="py-10 text-center text-sm text-destructive">
          {(error as Error)?.message ?? 'Não foi possível carregar a lista.'}
        </CardContent>
      </Card>
    )
  }

  if (isLoading || !data) {
    return (
      <div className="space-y-4">
        <div className="h-36 animate-pulse rounded-lg bg-surface-inset" />
        <div className="h-96 animate-pulse rounded-lg bg-surface-inset" />
      </div>
    )
  }

  const historyDays = data.base_start
    ? Math.round(
      (new Date(`${data.reference_date}T12:00:00`).getTime()
        - new Date(`${data.base_start}T12:00:00`).getTime()) / 86_400_000)
    : null

  return (
    <div className="space-y-4">
      <div className="no-print flex flex-wrap items-center gap-2">
        <div className="flex items-center gap-2">
          <span className="text-xs text-muted-foreground">Sem vender há mais de</span>
          <Select
            value={String(minDays)}
            onValueChange={(v) => { setMinDays(Number(v)); setShown(PAGE) }}
          >
            <SelectTrigger className="h-control-sm w-[120px] rounded-sm text-[13px]">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {WINDOWS.map((w) => (
                <SelectItem key={w} value={String(w)}>{WINDOW_LABEL[w]}</SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
        <div className="relative min-w-[200px] flex-1 sm:max-w-xs">
          <Search className="absolute left-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-mono-500" />
          <Input
            value={q}
            onChange={(e) => { setQ(e.target.value); setShown(PAGE) }}
            placeholder="Buscar por SKU, nome ou categoria…"
            className="h-control-sm rounded-sm pl-8 text-[13px]"
          />
        </div>
        <Button
          variant="outline"
          size="sm"
          onClick={exportCsv}
          disabled={filtered.length === 0}
          className="gap-1.5"
        >
          <Download className="h-3.5 w-3.5" /> Exportar CSV
        </Button>
        <Button
          variant="outline"
          size="sm"
          onClick={printReport}
          disabled={filtered.length === 0}
          className="gap-1.5"
        >
          <Printer className="h-3.5 w-3.5" /> Baixar PDF
        </Button>
      </div>

      {/* O documento. O recorte que está na tela é o que sai no papel — quem
          filtrou "liquidar" imprime a lista de liquidação, não o catálogo. */}
      <div id="report-doc" className="space-y-4">
        <PrintHeader
          title="Capital encalhado"
          company={company?.name}
          caption={`Estoque sem saída há mais de ${WINDOW_LABEL[minDays].toLowerCase()}`
            + (action ? ` · ${ACTION_BY_KEY[action].label}` : '')
            + (q.trim() ? ` · busca "${q.trim()}"` : '')}
          referenceDate={data.reference_date}
          provenance="catálogo ao vivo"
        />

        <Card>
          <CardHeader className="no-print pb-3">
            <CardTitleRow
              noteLabel="Como a lista é montada"
              note={
                <>
                  <p>
                    "Parado há N dias" é contado contra a{' '}
                    <strong className="text-ink">última venda da empresa</strong> ({fmtDate(data.reference_date)}),
                    não contra o calendário — sync parado uma semana envelheceria o catálogo inteiro
                    de uma vez.
                  </p>
                  <p>
                    A lista sai do catálogo ao vivo, não do último cálculo: por isso enxerga peça
                    desativada no ERP, que o motor não calcula e que no Painel não aparece em faixa
                    nenhuma. Conta os depósitos disponíveis para venda, a mesma definição do Pedido
                    de compra.
                  </p>
                  <p>
                    O corte entre <strong className="text-ink">liquidar</strong> e{' '}
                    <strong className="text-ink">deixar esgotar</strong> é de Pareto, não um valor
                    fixo: os itens que juntos somam os primeiros 80% do dinheiro parado merecem
                    campanha, a cauda sai no arrasto. Um limite em reais funcionaria numa empresa e
                    em nenhuma outra.
                  </p>
                  <p>
                    O que não dá para saber: há quanto tempo a PEÇA está na prateleira. Não existe
                    data de recebimento na base, então tudo aqui é sobre a última saída.
                  </p>
                </>
              }
            >
              <CardTitle className="text-card-title">Capital encalhado</CardTitle>
              <CardDescription>
                Estoque sem saída há mais de {WINDOW_LABEL[minDays].toLowerCase()}
                {historyDays != null && ` · ${formatInt(Math.round(historyDays / 7))} semanas de histórico`}
              </CardDescription>
            </CardTitleRow>
          </CardHeader>
          <CardContent className="space-y-4">
            <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1">
              <span className="font-data text-3xl font-semibold leading-none tabular-nums">
                {formatBRL(report.cost)}
              </span>
              <span className="text-sm text-muted-foreground">
                {(report.share * 100).toFixed(1).replace('.', ',')}% do estoque a custo ·{' '}
                {formatInt(report.pieces)} peças em {formatInt(report.items.length)} SKUs
              </span>
            </div>

            {/* As quatro saídas. Cada cartão é também o filtro da tabela — a
                pergunta "quanto disso é sortimento?" e a ação de ver quais são
                é a mesma pergunta, e separá-las em resumo + filtro obrigaria a
                ler um número aqui e procurá-lo ali embaixo. */}
            <div className="no-print grid gap-2 sm:grid-cols-2 xl:grid-cols-4">
              {STALLED_ACTIONS.map((a) => {
                const b = report.byAction[a.key]
                const on = action === a.key
                return (
                  <button
                    key={a.key}
                    type="button"
                    aria-pressed={on}
                    onClick={() => { setAction(on ? null : a.key); setShown(PAGE) }}
                    className={`space-y-1.5 rounded-sm border p-3 text-left transition-ui focus-visible:outline-none focus-visible:shadow-focus ${
                      on ? 'border-brand-600 bg-brand-50' : 'border-border hover:border-border-strong'
                    }`}
                  >
                    <div className="flex items-center justify-between gap-2">
                      <span className={`rounded-xs px-1.5 py-0.5 text-micro font-medium ${TONE[a.tone]}`}>
                        {a.label}
                      </span>
                      <span className="font-data text-micro tabular-nums text-muted-foreground">
                        {formatInt(b.skus)} {b.skus === 1 ? 'SKU' : 'SKUs'}
                      </span>
                    </div>
                    <p className="font-data text-lg font-semibold leading-none tabular-nums">
                      {formatBRL(b.cost)}
                    </p>
                    <p className="text-micro leading-snug text-muted-foreground">{a.advice}</p>
                  </button>
                )
              })}
            </div>
          </CardContent>
        </Card>

        <Card>
          <CardContent className="pt-5">
            {filtered.length === 0 ? (
              <div className="flex flex-col items-center gap-2 py-16 text-center">
                <PackageX className="h-6 w-6 text-muted-foreground" />
                <p className="text-sm text-muted-foreground">
                  {report.items.length === 0
                    ? `Nenhum produto com estoque está sem vender há mais de ${WINDOW_LABEL[minDays].toLowerCase()}.`
                    : 'Nenhum produto neste recorte.'}
                </p>
              </div>
            ) : (
              <>
                <Table>
                  <TableHeader>
                    <TableRow>
                      <TableHead>Produto</TableHead>
                      <TableHead className="text-right">Última venda</TableHead>
                      <TableHead className="text-right">Peças</TableHead>
                      <TableHead className="text-right">Capital</TableHead>
                      <TableHead className="text-right">Recomendação</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {filtered.slice(0, shown).map((it) => {
                      const r = it.row
                      const a = ACTION_BY_KEY[it.action]
                      return (
                        <TableRow
                          key={r.id}
                          onClick={() => navigate(`/analise/produto/${r.id}`)}
                          className="cursor-pointer"
                        >
                          <TableCell className="max-w-0">
                            <ProductCell image={r.image_url} name={r.name} />
                            <div className="mt-0.5 flex flex-wrap items-center gap-1.5 pl-12 text-micro text-muted-foreground">
                              <span className="font-data">{r.sku ?? 'sem SKU'}</span>
                              {r.category && <span className="truncate">· {r.category}</span>}
                              {/* Dois estados que mudam a leitura da linha e não
                                  são dedutíveis do número: fora de coleção já foi
                                  decidido, inativo o motor nem enxerga. */}
                              {r.discontinued && (
                                <span className="rounded-xs bg-surface-inset px-1 py-0.5">fora de coleção</span>
                              )}
                              {!r.is_active && (
                                <span className="rounded-xs bg-warning-100 px-1 py-0.5 text-warning-800">
                                  inativo no ERP
                                </span>
                              )}
                            </div>
                          </TableCell>
                          <TableCell className="whitespace-nowrap text-right">
                            {it.days == null ? (
                              <>
                                <span className="font-data text-xs font-medium">Nunca vendeu</span>
                                <span className="block text-micro text-muted-foreground">
                                  em todo o histórico
                                </span>
                              </>
                            ) : (
                              <>
                                <span className="font-data text-xs font-medium tabular-nums">
                                  há {formatInt(it.days)} dias
                                </span>
                                <span className="block font-data text-micro tabular-nums text-muted-foreground">
                                  {fmtDate(r.last_sale)}
                                </span>
                              </>
                            )}
                          </TableCell>
                          <TableCell className="text-right font-data text-xs tabular-nums">
                            {formatInt(it.stock)}
                          </TableCell>
                          <TableCell className="text-right font-data text-xs font-semibold tabular-nums">
                            {formatBRL(it.cost)}
                          </TableCell>
                          <TableCell className="text-right">
                            <span className={`inline-block rounded-xs px-1.5 py-0.5 text-micro font-medium ${TONE[a.tone]}`}>
                              {a.label}
                            </span>
                          </TableCell>
                        </TableRow>
                      )
                    })}
                  </TableBody>
                </Table>

                {shown < filtered.length && (
                  <div className="no-print flex items-center justify-center gap-3 border-t border-border pt-3">
                    <span className="text-micro text-muted-foreground">
                      {formatInt(shown)} de {formatInt(filtered.length)}
                    </span>
                    <Button variant="outline" size="sm" onClick={() => setShown((s) => s + PAGE)}>
                      Mostrar mais
                    </Button>
                  </div>
                )}
              </>
            )}
          </CardContent>
        </Card>
      </div>
    </div>
  )
}
