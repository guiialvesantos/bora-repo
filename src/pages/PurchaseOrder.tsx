import { useMemo, useState } from 'react'
import { toast } from 'sonner'
import { Download, CircleSlash, FilePlus2, History, Loader2, RefreshCw, RotateCcw } from 'lucide-react'
import { useCurrentSnapshot, useComputeSnapshot, useSnapshotItems } from '@/hooks/useCurrentSnapshot'
import { useCompany } from '@/contexts/CompanyContext'
import { useDataHealth } from '@/hooks/useDataHealth'
import { useProductImages } from '@/hooks/useProductImages'
import {
  useCreatePurchaseOrder, usePurchaseOrders, useUpdateOrderStatus,
} from '@/hooks/usePurchaseOrders'
import type { PurchaseOrderRow, PurchaseStatus } from '@/hooks/usePurchaseOrders'
import { ProductCell } from '@/components/ProductThumb'
import { ColLabel } from '@/components/InfoHint'
import { formatBRL, formatInt } from '@/lib/money'
import { num, maybeNum } from '@/lib/replenishment-types'
import { Button } from '@/components/ui/button'
import { Badge } from '@/components/ui/badge'
import { Input } from '@/components/ui/input'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import {
  Table, TableBody, TableCell, TableFooter, TableHead, TableHeader, TableRow,
} from '@/components/ui/table'

function n(v: string | null) {
  const x = maybeNum(v)
  return x == null ? '—' : formatInt(x)
}

/** Meio-dia porque `date` puro vira UTC e retrocede um dia em São Paulo. */
function dmy(v: string | null) {
  if (!v) return null
  return new Date(`${v}T12:00:00`).toLocaleDateString('pt-BR')
}

/** CSV com `;` e vírgula decimal: é o que o Excel em pt-BR abre sem perguntar nada. */
function toCsv(rows: (string | number)[][]) {
  return rows
    .map((r) => r.map((c) => {
      const s = typeof c === 'number' ? c.toFixed(2).replace('.', ',') : c
      return /[;"\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s
    }).join(';'))
    .join('\r\n')
}

const STATUS: Record<PurchaseStatus, { label: string; className: string }> = {
  draft: { label: 'Rascunho', className: 'border-warning-300 text-warning-800' },
  open: { label: 'Enviado', className: 'border-cyan-300 text-cyan-900' },
  received: { label: 'Recebido', className: 'border-success-300 text-success-800' },
  cancelled: { label: 'Cancelado', className: 'border-border text-muted-foreground' },
}

function OrderHistory() {
  const { data: orders = [], isLoading } = usePurchaseOrders()
  const setStatus = useUpdateOrderStatus()

  function totals(o: PurchaseOrderRow) {
    const pieces = o.purchase_order_items.reduce((s, i) => s + num(i.qty_ordered), 0)
    const open = o.purchase_order_items.reduce((s, i) => s + num(i.qty_open), 0)
    // Pedido vindo do Tiny não traz custo. Somar nulo como zero e mostrar
    // "R$ 0,00" afirmaria que a compra foi de graça — melhor não afirmar nada.
    const priced = o.purchase_order_items.some((i) => i.unit_cost != null)
    const cost = priced
      ? o.purchase_order_items.reduce((s, i) => s + num(i.qty_ordered) * num(i.unit_cost), 0)
      : null
    return { pieces, open, cost }
  }

  return (
    <Card>
      <CardHeader className="pb-3">
        <CardTitle className="flex items-center gap-2 text-base">
          <History className="h-4 w-4" /> Pedidos de compra
        </CardTitle>
        <CardDescription>
          Tudo que está a caminho, venha daqui ou do Tiny. Enquanto o pedido está como rascunho
          ou enviado, as peças em aberto contam como em trânsito e o motor para de sugerir a
          mesma compra. Cancelar devolve as peças à sugestão.
        </CardDescription>
      </CardHeader>
      <CardContent>
        {isLoading ? (
          <p className="text-sm text-muted-foreground">Carregando…</p>
        ) : orders.length === 0 ? (
          <p className="py-6 text-center text-sm text-muted-foreground">
            Nenhum pedido gerado ainda.
          </p>
        ) : (
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Pedido em</TableHead>
                <TableHead>Origem</TableHead>
                <TableHead>Fornecedor</TableHead>
                <TableHead>Situação</TableHead>
                <TableHead className="text-right">Linhas</TableHead>
                <TableHead className="text-right">Peças</TableHead>
                <TableHead className="text-right">Em aberto</TableHead>
                <TableHead className="text-right">Custo</TableHead>
                <TableHead />
              </TableRow>
            </TableHeader>
            <TableBody>
              {orders.map((o) => {
                const t = totals(o)
                // Só pedido nascido aqui aceita mudança de situação. Cancelar
                // uma OC que veio do Tiny não cancela nada no Tiny — o próximo
                // sync reescreve, e nesse intervalo as duas pontas discordam.
                const live = o.source === 'reporia'
                  && (o.status === 'draft' || o.status === 'open')
                return (
                  <TableRow key={o.id}>
                    {/* `ordered_on` é a data da compra; `created_at` é a data em que a
                        linha entrou aqui. Para OC vinda do Tiny as duas são semanas
                        diferentes, e a que interessa é a primeira. */}
                    <TableCell className="whitespace-nowrap text-xs tabular-nums">
                      {dmy(o.ordered_on) ?? new Date(o.created_at).toLocaleDateString('pt-BR')}
                    </TableCell>
                    <TableCell className="text-xs text-muted-foreground">
                      {o.source === 'reporia'
                        ? `cálculo${o.params_version ? ` · params v${o.params_version}` : ''}`
                        : o.source === 'tiny_v3' || o.source === 'tiny_v2'
                        ? `Tiny${o.external_id ? ` · ${o.external_id}` : ''}`
                        : o.source === 'import' ? 'planilha'
                        : o.source}
                    </TableCell>
                    <TableCell className="max-w-[16rem] truncate text-xs">
                      {o.supplier ?? '—'}
                    </TableCell>
                    <TableCell>
                      <Badge variant="outline" className={STATUS[o.status].className}>
                        {STATUS[o.status].label}
                      </Badge>
                    </TableCell>
                    <TableCell className="text-right tabular-nums">
                      {formatInt(o.purchase_order_items.length)}
                    </TableCell>
                    <TableCell className="text-right tabular-nums">{formatInt(t.pieces)}</TableCell>
                    <TableCell className="text-right tabular-nums">{formatInt(t.open)}</TableCell>
                    <TableCell className="text-right tabular-nums">
                      {t.cost == null ? '—' : formatBRL(t.cost)}
                    </TableCell>
                    <TableCell className="text-right">
                      {live && (
                        <div className="flex justify-end gap-1">
                          {o.status === 'draft' && (
                            <Button
                              size="sm" variant="ghost"
                              onClick={() => setStatus.mutate({ id: o.id, status: 'open' })}
                            >
                              Enviar
                            </Button>
                          )}
                          <Button
                            size="sm" variant="ghost"
                            onClick={() => setStatus.mutate({ id: o.id, status: 'received' })}
                          >
                            Recebido
                          </Button>
                          <Button
                            size="sm" variant="ghost" className="text-muted-foreground"
                            onClick={() => setStatus.mutate({ id: o.id, status: 'cancelled' })}
                          >
                            Cancelar
                          </Button>
                        </div>
                      )}
                    </TableCell>
                  </TableRow>
                )
              })}
            </TableBody>
          </Table>
        )}
      </CardContent>
    </Card>
  )
}

export default function PurchaseOrder() {
  const { canWrite } = useCompany()
  const { data: snapshot } = useCurrentSnapshot()
  const { data: items = [] } = useSnapshotItems(snapshot?.id)
  const { data: health } = useDataHealth()
  const { data: images } = useProductImages()
  const create = useCreatePurchaseOrder()
  const compute = useComputeSnapshot()

  // O ajuste do comprador vive só aqui até virar pedido. A chave ausente
  // significa "aceito o que o motor mandou" — assim o rascunho não precisa ser
  // preenchido para as 600 linhas antes de a tela desenhar.
  const [edits, setEdits] = useState<Record<string, string>>({})

  const lines = useMemo(
    () => items.filter((i) => i.should_order)
      .sort((a, b) => num(b.qty_to_order) * num(b.cmv_used) - num(a.qty_to_order) * num(a.cmv_used)),
    [items])

  const qtyOf = (productId: string, suggested: string) => {
    const raw = edits[productId]
    if (raw == null) return num(suggested)
    const v = Number(raw.replace(',', '.'))
    return Number.isFinite(v) && v > 0 ? v : 0
  }

  const ordered = lines
    .map((i) => ({ item: i, qty: qtyOf(i.product_id, i.qty_to_order) }))
    .filter((l) => l.qty > 0)

  const totalPieces = ordered.reduce((s, l) => s + l.qty, 0)
  const totalCost = ordered.reduce((s, l) => s + l.qty * num(l.item.cmv_used), 0)
  const touched = Object.keys(edits).length > 0

  const blocked = health?.blocking ?? []

  function exportCsv() {
    const header = ['SKU', 'Produto', 'Estoque', 'Em trânsito', 'Ponto de pedido',
                    'Estoque máximo', 'Sugerido', 'Qtd a pedir', 'Custo unitário', 'Custo da linha']
    const body = ordered.map(({ item: i, qty }) => [
      i.sku ?? '', i.name ?? '', num(i.stock_total), num(i.in_transit),
      num(i.reorder_point), num(i.max_stock), num(i.qty_to_order), qty,
      num(i.cmv_used), qty * num(i.cmv_used),
    ])
    const csv = toCsv([header, ...body, [],
      ['Total', '', '', '', '', '', '', totalPieces, '', totalCost]])
    // BOM para o Excel reconhecer UTF-8; sem ele os acentos saem quebrados.
    const blob = new Blob([`\uFEFF${csv}`], { type: 'text/csv;charset=utf-8' })
    const a = document.createElement('a')
    a.href = URL.createObjectURL(blob)
    a.download = `pedido-${snapshot?.reference_date ?? 'stock'}.csv`
    a.click()
    URL.revokeObjectURL(a.href)
  }

  function generate() {
    if (!snapshot) return
    create.mutate(
      {
        snapshotId: snapshot.id,
        lines: ordered.map(({ item, qty }) => ({ product_id: item.product_id, qty })),
      },
      {
        onSuccess: () => {
          setEdits({})
          toast.success(
            `Pedido gerado: ${formatInt(ordered.length)} linhas, ${formatInt(totalPieces)} peças. `
            + 'As peças já contam como em trânsito.',
          )
        },
        onError: (e) => toast.error(e.message),
      },
    )
  }

  // Recalcular troca o snapshot, e os ajustes do comprador são chaveados por
  // product_id contra o snapshot antigo. Manter a edição depois do recálculo
  // seria pedir uma quantidade decidida sobre números que não existem mais.
  function recompute() {
    compute.mutate('Recálculo manual', {
      onSuccess: () => {
        setEdits({})
        toast.success('Cálculo atualizado')
      },
      onError: (e) => toast.error(e.message),
    })
  }

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
          <Button disabled={!canWrite || compute.isPending} onClick={recompute}>
            {compute.isPending && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
            Calcular agora
          </Button>
        </CardContent>
      </Card>
    )
  }

  const model = snapshot.demand_model === 'weighted_90_180'
    ? 'ponderado 90/180'
    : 'longo prazo + janela recente'

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-start justify-between gap-4">
        <div>
          <h1 className="text-page-title">Pedido de compra</h1>
          <p className="text-sm text-muted-foreground">
            Itens em coleção cujo estoque mais o que está a caminho já caiu ao ponto de pedido.
          </p>
          {/* Proveniência no lugar de um seletor: a régua do cálculo se vê aqui,
              mas se troca em Configurações — senão quem compra escolhe a régua
              que produz o número que ele já queria. */}
          <p className="mt-1 text-xs text-muted-foreground">
            Calculado com params v{snapshot.params_version} · {model} · referência{' '}
            {new Date(`${snapshot.reference_date}T12:00:00`).toLocaleDateString('pt-BR')}
          </p>
        </div>
        <div className="flex gap-2">
          {touched && (
            <Button variant="ghost" onClick={() => setEdits({})}>
              <RotateCcw className="mr-2 h-4 w-4" /> Voltar ao sugerido
            </Button>
          )}
          <Button variant="outline" disabled={!canWrite || compute.isPending} onClick={recompute}>
            <RefreshCw className={`mr-2 h-4 w-4 ${compute.isPending ? 'animate-spin' : ''}`} />
            Recalcular
          </Button>
          <Button
            variant="outline" onClick={exportCsv}
            disabled={blocked.length > 0 || ordered.length === 0}
          >
            <Download className="mr-2 h-4 w-4" /> Exportar CSV
          </Button>
          <Button
            onClick={generate}
            disabled={blocked.length > 0 || ordered.length === 0 || create.isPending}
          >
            {create.isPending
              ? <Loader2 className="mr-2 h-4 w-4 animate-spin" />
              : <FilePlus2 className="mr-2 h-4 w-4" />}
            Gerar pedido
          </Button>
        </div>
      </div>

      {/* A única tela que bloqueia. Bloquear em todas ensinaria a ignorar. */}
      {blocked.length > 0 && (
        <Card className="border-error-300 bg-error-100">
          <CardHeader className="pb-3">
            <CardTitle className="flex items-center gap-2 text-base text-destructive">
              <CircleSlash className="h-4 w-4" /> Não dá para gerar o pedido
            </CardTitle>
            <CardDescription>
              Comprar com dado faltando é comprar errado. Resolva na tela de saúde dos dados.
            </CardDescription>
          </CardHeader>
          <CardContent>
            <ul className="list-inside list-disc space-y-1 text-sm">
              {blocked.map((b) => <li key={b}>{b}</li>)}
            </ul>
          </CardContent>
        </Card>
      )}

      <Card>
        <CardHeader>
          <CardTitle className="text-base">
            {formatInt(ordered.length)} linhas · {formatInt(totalPieces)} peças ·{' '}
            {formatBRL(totalCost)}
          </CardTitle>
          <CardDescription>
            Ordenado pelo custo da linha — a decisão mais cara primeiro. A quantidade é editável:
            o comprador sabe de caixa fechada e pedido mínimo, que o motor não tem como saber.
            Zerar uma linha a tira do pedido.
          </CardDescription>
        </CardHeader>
        <CardContent>
          {lines.length === 0 ? (
            <p className="py-8 text-center text-sm text-muted-foreground">
              Nada a pedir nesta rodada.
            </p>
          ) : (
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>SKU</TableHead>
                  <TableHead>Produto</TableHead>
                  <TableHead className="text-right">
                    <ColLabel term="estoque">Estoque</ColLabel>
                  </TableHead>
                  <TableHead className="text-right">
                    <ColLabel term="transito">Trânsito</ColLabel>
                  </TableHead>
                  <TableHead className="text-right">
                    <ColLabel term="pp">PP</ColLabel>
                  </TableHead>
                  <TableHead className="text-right">
                    <ColLabel term="emax">Emáx</ColLabel>
                  </TableHead>
                  <TableHead className="text-right">
                    <ColLabel term="sugerido">Sugerido</ColLabel>
                  </TableHead>
                  <TableHead className="text-right">
                    <ColLabel term="pedir">Pedir</ColLabel>
                  </TableHead>
                  <TableHead className="text-right">
                    <ColLabel term="cmv">Custo un.</ColLabel>
                  </TableHead>
                  <TableHead className="text-right">
                    <ColLabel term="custoLinha">Custo da linha</ColLabel>
                  </TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {lines.map((i) => {
                  const qty = qtyOf(i.product_id, i.qty_to_order)
                  const changed = qty !== num(i.qty_to_order)
                  return (
                    <TableRow key={i.product_id} className={qty === 0 ? 'opacity-50' : undefined}>
                      <TableCell className="font-mono text-xs">{i.sku}</TableCell>
                      <TableCell className="max-w-[280px]">
                        <ProductCell image={images?.get(i.product_id)} name={i.name} />
                      </TableCell>
                      <TableCell className="text-right tabular-nums">{n(i.stock_total)}</TableCell>
                      <TableCell className="text-right tabular-nums">{n(i.in_transit)}</TableCell>
                      <TableCell className="text-right tabular-nums">{n(i.reorder_point)}</TableCell>
                      <TableCell className="text-right tabular-nums">{n(i.max_stock)}</TableCell>
                      <TableCell
                        className={`text-right tabular-nums ${
                          changed ? 'text-muted-foreground line-through' : ''}`}
                      >
                        {n(i.qty_to_order)}
                      </TableCell>
                      <TableCell className="text-right">
                        <Input
                          inputMode="numeric"
                          className="ml-auto h-8 w-20 text-right tabular-nums"
                          value={edits[i.product_id] ?? String(num(i.qty_to_order))}
                          onChange={(e) =>
                            setEdits({ ...edits, [i.product_id]: e.target.value })}
                        />
                      </TableCell>
                      <TableCell className="text-right tabular-nums">
                        {formatBRL(num(i.cmv_used))}
                      </TableCell>
                      <TableCell className="text-right tabular-nums">
                        {formatBRL(qty * num(i.cmv_used))}
                      </TableCell>
                    </TableRow>
                  )
                })}
              </TableBody>
              <TableFooter>
                <TableRow>
                  <TableCell colSpan={7}>Total</TableCell>
                  <TableCell className="text-right tabular-nums">{formatInt(totalPieces)}</TableCell>
                  <TableCell />
                  <TableCell className="text-right tabular-nums">{formatBRL(totalCost)}</TableCell>
                </TableRow>
              </TableFooter>
            </Table>
          )}
        </CardContent>
      </Card>

      <OrderHistory />
    </div>
  )
}
