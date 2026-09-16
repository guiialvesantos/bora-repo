import { useRef, useState } from 'react'
import { useQueryClient } from '@tanstack/react-query'
import { toast } from 'sonner'
import { AlertTriangle, CheckCircle2, FileUp, Loader2, RefreshCw, Upload } from 'lucide-react'
import { supabase } from '@/lib/supabase'
import { useCompany } from '@/contexts/CompanyContext'
import { useDataHealth } from '@/hooks/useDataHealth'
import { useComputeSnapshot } from '@/hooks/useCurrentSnapshot'
import { parseMatrix, readMatrix } from '@/lib/import-parse'
import type { ParsedFile } from '@/lib/import-parse'
import { formatInt } from '@/lib/money'
import { KIND_LABEL } from '@/lib/replenishment-types'
import type { ImportKind } from '@/lib/replenishment-types'
import { Button } from '@/components/ui/button'
import { Badge } from '@/components/ui/badge'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'

/** Lotes de 500 registros: o PostgREST tem teto de payload, e 10.993 vendas passam. */
const CHUNK = 500

const KINDS: { kind: ImportKind; hint: string }[] = [
  { kind: 'products', hint: 'SKU, nome, estoque, preço de venda, CMV. Export "Estoque" do Olist.' },
  { kind: 'sales', hint: 'Data, quantidade, SKU. Uma linha por item vendido.' },
  { kind: 'in_transit', hint: 'SKU, previsão, quantidade, categoria. O que já foi comprado e não chegou.' },
  { kind: 'discontinued', hint: 'SKU e nome dos itens fora de coleção. Prefira a tela Produtos: marcações feitas lá são preservadas pelo import.' },
  { kind: 'sigma', hint: 'Opcional. Só serve ao modo de paridade — o motor calcula o σ sozinho.' },
]

function dt(v: string | null | undefined) {
  if (!v) return null
  return new Date(v).toLocaleString('pt-BR', { dateStyle: 'short', timeStyle: 'short' })
}

interface Staged extends ParsedFile {
  filename: string
  byPosition: boolean
}

export default function Import() {
  const { companyId } = useCompany()
  const { data: health } = useDataHealth()
  const compute = useComputeSnapshot()
  const qc = useQueryClient()

  const [staged, setStaged] = useState<Partial<Record<ImportKind, Staged>>>({})
  const [busy, setBusy] = useState<ImportKind | null>(null)
  const inputs = useRef<Partial<Record<ImportKind, HTMLInputElement | null>>>({})

  async function onPick(kind: ImportKind, file: File | undefined) {
    if (!file) return
    try {
      const parsed = parseMatrix(kind, await readMatrix(file))
      if (parsed.rows.length === 0) {
        toast.error('Nenhuma linha válida no arquivo.')
        return
      }
      setStaged((s) => ({
        ...s,
        [kind]: { ...parsed, filename: file.name, byPosition: parsed.byPosition },
      }))
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'Não foi possível ler o arquivo.')
    }
  }

  async function apply(kind: ImportKind) {
    const item = staged[kind]
    if (!item || !companyId) return
    setBusy(kind)

    // `crypto.randomUUID` amarra os pedaços: se o upload morrer no meio, o lixo
    // fica no staging com este id e a base fica intacta.
    const batchId = crypto.randomUUID()
    try {
      for (let i = 0; i * CHUNK < item.rows.length; i++) {
        const { error } = await supabase.from('import_staging').insert({
          company_id: companyId,
          batch_id: batchId,
          kind,
          seq: i,
          rows: item.rows.slice(i * CHUNK, (i + 1) * CHUNK),
        })
        if (error) throw error
      }

      const { error } = await supabase.rpc('import_apply', {
        _company_id: companyId,
        _batch_id: batchId,
        _kind: kind,
        _filename: item.filename,
      })
      if (error) throw error

      setStaged((s) => ({ ...s, [kind]: undefined }))
      if (inputs.current[kind]) inputs.current[kind]!.value = ''
      qc.invalidateQueries({ queryKey: ['data-health'] })
      toast.success(`${KIND_LABEL[kind]}: ${formatInt(item.rows.length)} linhas importadas.`)
    } catch (e) {
      // O lote que sobrou no staging não corrompe nada — mas também não serve
      // para mais nada, então sai junto com o erro.
      await supabase.from('import_staging').delete()
        .eq('company_id', companyId).eq('batch_id', batchId)
      toast.error(e instanceof Error ? e.message : 'Falha ao importar.')
    } finally {
      setBusy(null)
    }
  }

  const sources = Object.fromEntries((health?.sources ?? []).map((s) => [s.kind, s]))

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-start justify-between gap-4">
        <div>
          <h1 className="text-page-title">Importar</h1>
          <p className="max-w-2xl text-sm text-muted-foreground">
            Os mesmos arquivos que hoje são colados na planilha. Cada importação substitui a
            fonte inteira — não existe importação parcial, porque meia base dá meio número e
            meio número não dá para conferir.
          </p>
        </div>
        <Button
          variant="outline"
          onClick={() => compute.mutate(undefined, {
            onSuccess: () => toast.success('Recalculado.'),
            onError: (e) => toast.error(e.message),
          })}
          disabled={compute.isPending}
        >
          {compute.isPending
            ? <Loader2 className="mr-2 h-4 w-4 animate-spin" />
            : <RefreshCw className="mr-2 h-4 w-4" />}
          Recalcular
        </Button>
      </div>

      <div className="grid gap-4 lg:grid-cols-2">
        {KINDS.map(({ kind, hint }) => {
          const src = sources[kind]
          const item = staged[kind]
          const isBusy = busy === kind

          return (
            <Card key={kind}>
              <CardHeader className="pb-3">
                <CardTitle className="flex items-center justify-between gap-2 text-base">
                  {KIND_LABEL[kind]}
                  {src && !src.missing && (
                    <Badge variant={src.stale ? 'secondary' : 'outline'} className="gap-1 font-normal">
                      {src.stale
                        ? <AlertTriangle className="h-3 w-3" />
                        : <CheckCircle2 className="h-3 w-3 text-success-700" />}
                      {formatInt(src.row_count)} linhas · {dt(src.refreshed_at)}
                    </Badge>
                  )}
                </CardTitle>
                <CardDescription>{hint}</CardDescription>
              </CardHeader>

              <CardContent className="space-y-3">
                <input
                  ref={(el) => { inputs.current[kind] = el }}
                  type="file"
                  accept=".xlsx,.xls,.csv"
                  className="block w-full text-sm text-muted-foreground file:mr-3 file:cursor-pointer
                             file:rounded-md file:border file:border-border file:bg-muted
                             file:px-3 file:py-1.5 file:text-sm file:font-medium
                             file:text-foreground hover:file:bg-muted/70"
                  onChange={(e) => onPick(kind, e.target.files?.[0])}
                />

                {item && (
                  <div className="space-y-2 rounded-md border border-border bg-muted/30 p-3">
                    <p className="flex items-center gap-2 text-sm">
                      <FileUp className="h-4 w-4 text-muted-foreground" />
                      <span className="truncate font-medium">{item.filename}</span>
                    </p>
                    <p className="text-sm text-muted-foreground">
                      {formatInt(item.rows.length)} linhas válidas
                      {item.skipped.length > 0
                        && ` · ${formatInt(item.skipped.length)} descartadas`}
                    </p>

                    {item.byPosition && (
                      <p className="flex items-start gap-2 text-xs text-warning-700">
                        <AlertTriangle className="mt-0.5 h-3 w-3 shrink-0" />
                        Cabeçalho não reconhecido — as colunas foram lidas pela posição.
                        Confira a prévia antes de confirmar.
                      </p>
                    )}

                    {item.skipped.length > 0 && (
                      <details className="text-xs text-muted-foreground">
                        <summary className="cursor-pointer">Ver linhas descartadas</summary>
                        <ul className="mt-1 max-h-32 space-y-0.5 overflow-auto">
                          {item.skipped.slice(0, 50).map((s) => (
                            <li key={s.row}>Linha {s.row}: {s.reason}</li>
                          ))}
                          {item.skipped.length > 50 && <li>…</li>}
                        </ul>
                      </details>
                    )}

                    <div className="overflow-x-auto rounded border border-border bg-background">
                      <table className="w-full text-xs">
                        <thead className="bg-muted/50">
                          <tr>
                            {Object.keys(item.rows[0]).map((k) => (
                              <th key={k} className="px-2 py-1 text-left font-medium">{k}</th>
                            ))}
                          </tr>
                        </thead>
                        <tbody>
                          {item.rows.slice(0, 3).map((r, i) => (
                            <tr key={i} className="border-t border-border">
                              {Object.keys(item.rows[0]).map((k) => (
                                <td key={k} className="whitespace-nowrap px-2 py-1">
                                  {/* Aspas para o espaço sobrando aparecer: é exatamente
                                      o caso que faz peça em trânsito sumir. */}
                                  {typeof r[k] === 'string' && r[k] !== (r[k] as string).trim()
                                    ? `"${r[k]}"`
                                    : String(r[k] ?? '—')}
                                </td>
                              ))}
                            </tr>
                          ))}
                        </tbody>
                      </table>
                    </div>

                    <Button size="sm" onClick={() => apply(kind)} disabled={isBusy}>
                      {isBusy
                        ? <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                        : <Upload className="mr-2 h-4 w-4" />}
                      Substituir {KIND_LABEL[kind].toLowerCase()}
                    </Button>
                  </div>
                )}
              </CardContent>
            </Card>
          )
        })}
      </div>

      <p className="text-sm text-muted-foreground">
        Importar não recalcula sozinho. O snapshot é uma decisão datada: você importa tudo o que
        tem, confere na saúde dos dados, e só então recalcula — assim as quatro telas mudam
        juntas, e não uma a cada arquivo.
      </p>
    </div>
  )
}
