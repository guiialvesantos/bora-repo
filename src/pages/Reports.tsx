import { useMemo, useState } from 'react'
import { Download, FileText, Printer } from 'lucide-react'
import { useCompany } from '@/contexts/CompanyContext'
import { useReportCatalog } from '@/hooks/useReportCatalog'
import {
  REPORTS, REPORT_BY_KEY, DEFAULT_PARAMS, categoriesOf, formatCell, isNumeric,
  reportToCsv, buildSellThrough, buildPosicao,
} from '@/lib/reports'
import type { ReportKey, ReportParams, ReportTable } from '@/lib/reports'
import { printDocument } from '@/lib/print'
import { LoadingBlock } from '@/components/brand/Logo'
import { Button } from '@/components/ui/button'
import { Card, CardContent } from '@/components/ui/card'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Switch } from '@/components/ui/switch'
import {
  Select, SelectContent, SelectItem, SelectTrigger, SelectValue,
} from '@/components/ui/select'
import {
  Table, TableBody, TableCell, TableFooter, TableHead, TableHeader, TableRow,
} from '@/components/ui/table'

/** Meio-dia porque `date` puro vira UTC e retrocede um dia em São Paulo. */
function dmy(v: string | null | undefined) {
  if (!v) return '—'
  return new Date(`${v}T12:00:00`).toLocaleDateString('pt-BR')
}

export default function Reports() {
  const { company } = useCompany()
  const [key, setKey] = useState<ReportKey>('sell-through')
  const [params, setParams] = useState<ReportParams>(DEFAULT_PARAMS)

  const def = REPORT_BY_KEY[key]

  const catalog = useReportCatalog(true)

  const set = (patch: Partial<ReportParams>) => setParams({ ...params, ...patch })

  const categories = useMemo(
    () => categoriesOf(catalog.data?.rows ?? []),
    [catalog.data])

  const table: ReportTable | null = useMemo(() => {
    if (!catalog.data) return null
    return key === 'sell-through'
      ? buildSellThrough(catalog.data, params)
      : buildPosicao(catalog.data, params)
  }, [key, catalog.data, params])

  const referenceDate = catalog.data?.reference_date

  const loading = catalog.isLoading
  const error = catalog.error

  const slug = `borarepo-${key}-${referenceDate ?? 'stock'}`

  function exportCsv() {
    if (!table) return
    const blob = new Blob([`\uFEFF${reportToCsv(table)}`],
      { type: 'text/csv;charset=utf-8' })
    const a = document.createElement('a')
    a.href = URL.createObjectURL(blob)
    a.download = `${slug}.csv`
    a.click()
    URL.revokeObjectURL(a.href)
  }

  return (
    <div className="space-y-6">
      <div className="no-print flex flex-wrap items-start justify-between gap-4">
        <div>
          <h1 className="text-page-title">Relatórios</h1>
          <p className="text-sm text-muted-foreground">
            Recorte, confira e leve para a reunião — em PDF ou planilha.
          </p>
        </div>
        <div className="flex gap-2">
          <Button
            variant="outline" onClick={exportCsv}
            disabled={!table || table.rows.length === 0}
          >
            <Download className="mr-2 h-4 w-4" /> Exportar CSV
          </Button>
          <Button
            onClick={() => printDocument(slug)}
            disabled={!table || table.rows.length === 0}
          >
            <Printer className="mr-2 h-4 w-4" /> Baixar PDF
          </Button>
        </div>
      </div>

      {/* Escolha do relatório: cada cartão diz a PERGUNTA que ele responde, não
          só o nome — "Sell-through" sozinho não avisa para que serve. */}
      <div className="no-print grid gap-3 sm:grid-cols-2">
        {REPORTS.map((r) => {
          const active = r.key === key
          return (
            <button
              key={r.key}
              type="button"
              aria-pressed={active}
              onClick={() => setKey(r.key)}
              className={
                'rounded-lg border p-3 text-left transition-colors '
                + (active
                  ? 'border-brand-500 bg-brand-50 ring-1 ring-brand-500'
                  : 'border-border hover:border-mono-300 hover:bg-surface-inset')
              }
            >
              <div className="flex items-center gap-2">
                <FileText
                  className={`h-4 w-4 ${active ? 'text-brand-600' : 'text-muted-foreground'}`}
                />
                <span className="text-sm font-medium">{r.title}</span>
              </div>
              <p className="mt-1 text-xs leading-snug text-muted-foreground">
                {r.question}
              </p>
            </button>
          )
        })}
      </div>

      {/* Parâmetros do relatório escolhido. */}
      <Card className="no-print">
        <CardContent className="flex flex-wrap items-end gap-4 py-4">
          {key === 'sell-through' && (
            <>
              <div className="space-y-1">
                <Label className="text-xs text-muted-foreground">Sell-through mínimo</Label>
                <div className="flex items-center gap-1">
                  <Input
                    inputMode="numeric"
                    className="h-control-sm w-20 text-right tabular-nums"
                    value={String(params.minPct)}
                    onChange={(e) => set({ minPct: Number(e.target.value) || 0 })}
                  />
                  <span className="text-sm text-muted-foreground">%</span>
                </div>
              </div>
              <div className="space-y-1">
                <Label className="text-xs text-muted-foreground">Mínimo de peças vendidas</Label>
                <Input
                  inputMode="numeric"
                  className="h-control-sm w-20 text-right tabular-nums"
                  value={String(params.minUnits)}
                  onChange={(e) => set({ minUnits: Number(e.target.value) || 0 })}
                />
                {/* O piso existe porque vender 2 peças e zerar também dá 100%. */}
                <p className="text-[11px] text-muted-foreground">
                  sem piso, quem vendeu 2 peças aparece como 100%
                </p>
              </div>
            </>
          )}

          {key === 'posicao' && (
            <div className="flex items-center gap-2 pb-1">
              <Switch
                checked={params.includeInactive}
                onCheckedChange={(v) => set({ includeInactive: v })}
              />
              <Label className="text-xs text-muted-foreground">
                Incluir itens inativos no ERP
              </Label>
            </div>
          )}

          {categories.length > 1 && (
            <div className="space-y-1">
              <Label className="text-xs text-muted-foreground">Categoria</Label>
              <Select value={params.category} onValueChange={(v) => set({ category: v })}>
                <SelectTrigger className="h-control-sm w-[200px] rounded-sm text-[13px]">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="all">Todas</SelectItem>
                  {categories.map((c) => (
                    <SelectItem key={c} value={c}>{c}</SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
          )}

        </CardContent>
      </Card>

      {error ? (
        <Card>
          <CardContent className="py-10 text-center text-sm text-destructive">
            {(error as Error).message}
          </CardContent>
        </Card>
      ) : loading ? (
        <LoadingBlock className="min-h-[320px]" />
      ) : !table ? (
        /* Consulta respondeu e mesmo assim não há tabela: não é espera, é
           ausência de dado. Antes caía no mesmo ramo do carregamento e ficava
           num esqueleto perpétuo, sem dizer o que fazer. */
        <Card>
          <CardContent className="py-10 text-center text-sm text-muted-foreground">
            Sem dados para este relatório.
          </CardContent>
        </Card>
      ) : (
        /* O documento. Tudo fora daqui some na impressão. */
        <div id="report-doc" className="rounded-lg border bg-white p-6">
          <div className="print-keep mb-5 border-b pb-4">
            <div className="flex items-baseline justify-between gap-4">
              <h2 className="text-xl font-semibold">{def.title}</h2>
              <span className="text-sm text-muted-foreground">
                {company?.name ?? ''}
              </span>
            </div>
            <p className="mt-1 text-sm text-muted-foreground">{table.caption}</p>
            {/* Procedência: um relatório é cobrado semanas depois, e sem a data
                de referência ninguém sabe de que foto ele fala. A referência é
                a última venda da empresa, não o dia da impressão. */}
            <p className="mt-2 text-xs text-muted-foreground">
              Referência {dmy(referenceDate)}
              {' · '}gerado em {new Date().toLocaleDateString('pt-BR')} pelo BoraRepô
            </p>
          </div>

          <div className="print-keep mb-5 flex flex-wrap gap-x-10 gap-y-3">
            {table.summary.map((s) => (
              <div key={s.label}>
                <p className="text-[11px] uppercase tracking-wide text-muted-foreground">
                  {s.label}
                </p>
                <p className="text-lg font-semibold tabular-nums">{s.value}</p>
              </div>
            ))}
          </div>

          {table.breakdown && (
            <div className="print-keep mb-5 rounded-md border p-3">
              <p className="mb-2 text-xs font-medium uppercase tracking-wide text-muted-foreground">
                {table.breakdown.title}
              </p>
              <div className="grid gap-x-8 gap-y-1 sm:grid-cols-2 lg:grid-cols-3">
                {table.breakdown.rows.map((r) => (
                  <div key={r.label} className="flex justify-between gap-3 text-xs">
                    <span className="truncate">{r.label}</span>
                    <span className="shrink-0 tabular-nums text-muted-foreground">
                      {r.value}
                    </span>
                  </div>
                ))}
              </div>
            </div>
          )}

          {table.rows.length === 0 ? (
            <p className="py-10 text-center text-sm text-muted-foreground">{table.empty}</p>
          ) : (
            <Table>
              <TableHeader>
                <TableRow>
                  {table.columns.map((c) => (
                    <TableHead
                      key={c.key}
                      className={isNumeric(c.format) ? 'text-right' : undefined}
                    >
                      {c.label}
                    </TableHead>
                  ))}
                </TableRow>
              </TableHeader>
              <TableBody>
                {table.rows.map((r, i) => (
                  <TableRow key={`${r.sku}-${i}`}>
                    {table.columns.map((c) => (
                      <TableCell
                        key={c.key}
                        className={
                          (isNumeric(c.format) ? 'text-right tabular-nums ' : '')
                          + (c.format === 'mono' ? 'font-mono text-xs ' : '')
                          + (c.key === 'name' ? 'max-w-[320px] truncate' : '')
                        }
                        title={c.key === 'name' ? String(r[c.key] ?? '') : undefined}
                      >
                        {formatCell(r[c.key], c.format)}
                      </TableCell>
                    ))}
                  </TableRow>
                ))}
              </TableBody>
              {table.total && (
                <TableFooter>
                  <TableRow>
                    {table.columns.map((c) => (
                      <TableCell
                        key={c.key}
                        className={isNumeric(c.format) ? 'text-right tabular-nums' : undefined}
                      >
                        {table.total![c.key] == null ? '' : formatCell(table.total![c.key], c.format)}
                      </TableCell>
                    ))}
                  </TableRow>
                </TableFooter>
              )}
            </Table>
          )}
        </div>
      )}
    </div>
  )
}
