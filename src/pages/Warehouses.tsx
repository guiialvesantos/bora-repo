import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { toast } from 'sonner'
import { useCompany } from '@/contexts/CompanyContext'
import { usePublishParams, useReplenishmentParams } from '@/hooks/useReplenishmentParams'
import { supabase } from '@/lib/supabase'
import { fetchAllRows } from '@/lib/paging'
import { formatInt } from '@/lib/money'
import { LoadingBlock } from '@/components/brand/Logo'
import { Switch } from '@/components/ui/switch'
import { Card, CardContent } from '@/components/ui/card'
import {
  Table, TableBody, TableCell, TableHead, TableHeader, TableRow,
} from '@/components/ui/table'

interface WarehouseRow {
  id: string
  name: string
  include_in_available: boolean
}

/**
 * Base do `E` do motor: saldo físico ou disponível para venda (saldo −
 * reservas de pedidos em aberto). É parâmetro versionado do motor, não flag
 * de depósito — mudar a base muda pedido de compra, então a troca publica
 * uma versão nova de parâmetros e recalcula na hora (snapshot auditável).
 */
function StockBasisToggle() {
  const { data: params } = useReplenishmentParams()
  const publish = usePublishParams()

  // Empresa sem parâmetros ainda não roda o motor — nada a escolher.
  if (!params) return null
  const disponivel = params.stock_basis === 'disponivel'

  return (
    <div className="flex items-start justify-between gap-4 rounded-lg border border-border p-3">
      <div>
        <p className="text-sm font-medium">Descontar reservas do estoque</p>
        <p className="text-xs text-muted-foreground">
          Peças já vendidas e ainda não expedidas (reservadas em pedidos em aberto) deixam de
          contar como estoque no cálculo — o motor passa a usar o disponível para venda.
          A troca recalcula na hora e fica registrada no histórico de parâmetros.
        </p>
      </div>
      <Switch
        checked={disponivel}
        disabled={publish.isPending}
        aria-label="Descontar reservas do estoque"
        onCheckedChange={(value) => {
          publish.mutate(
            {
              patch: { stock_basis: value ? 'disponivel' : 'saldo' },
              note: value
                ? 'Estoque passa a descontar reservas (disponível para venda)'
                : 'Estoque volta ao saldo físico (sem descontar reservas)',
            },
            {
              onSuccess: () => toast.success('Base do estoque alterada e recalculada.'),
              onError: (e) => toast.error(e.message),
            },
          )
        }}
      />
    </div>
  )
}

/**
 * O motor de reposição soma só os depósitos marcados aqui (é o `E` do
 * cálculo). Devolução em avaliação, avaria, consignação e estoque de
 * marketplace (FBA) normalmente ficam de fora — mas a decisão é do usuário,
 * por isso o toggle. A mudança vale a partir do próximo cálculo.
 *
 * Saiu de dentro de Integrações e virou aba: depósito não é detalhe de quem
 * conectou o Tiny. Numa rede de farmácias cada loja chega com o seu, e a
 * lista cresce com o negócio — enquanto marcar o que conta como disponível é
 * decisão do motor, e vale igual para dado que entrou por planilha.
 */
export default function Warehouses() {
  const { companyId } = useCompany()
  const queryClient = useQueryClient()

  const { data: warehouses, isLoading } = useQuery({
    queryKey: ['warehouses', companyId],
    enabled: !!companyId,
    queryFn: async () => {
      const { data, error } = await supabase
        .from('warehouses')
        .select('id, name, include_in_available')
        .eq('company_id', companyId!)
        .order('name')
      if (error) throw error
      return data as WarehouseRow[]
    },
  })

  // Totais por depósito, só para dar contexto à decisão dos toggles.
  const { data: pieces } = useQuery({
    queryKey: ['warehouse-pieces', companyId],
    enabled: !!companyId,
    queryFn: async () => {
      const rows = await fetchAllRows(() =>
        supabase
          .from('product_stock')
          .select('warehouse_id, qty, qty_reserved')
          .eq('company_id', companyId!)
          .or('qty.neq.0,qty_reserved.neq.0'),
      )
      const map = new Map<string, { saldo: number; reservado: number }>()
      for (const r of rows as { warehouse_id: string; qty: number; qty_reserved: number }[]) {
        const acc = map.get(r.warehouse_id) ?? { saldo: 0, reservado: 0 }
        acc.saldo += Number(r.qty)
        acc.reservado += Number(r.qty_reserved)
        map.set(r.warehouse_id, acc)
      }
      return map
    },
  })

  const toggle = useMutation({
    mutationFn: async ({ id, value }: { id: string; value: boolean }) => {
      const { error } = await supabase
        .from('warehouses')
        .update({ include_in_available: value })
        .eq('id', id)
      if (error) throw error
    },
    // Otimista: o switch responde na hora; rollback se o banco recusar.
    onMutate: async ({ id, value }) => {
      await queryClient.cancelQueries({ queryKey: ['warehouses', companyId] })
      const previous = queryClient.getQueryData<WarehouseRow[]>(['warehouses', companyId])
      queryClient.setQueryData<WarehouseRow[]>(['warehouses', companyId], (old) =>
        old?.map((w) => (w.id === id ? { ...w, include_in_available: value } : w)))
      return { previous }
    },
    onError: (e, _vars, ctx) => {
      if (ctx?.previous) queryClient.setQueryData(['warehouses', companyId], ctx.previous)
      toast.error(e instanceof Error ? e.message : 'Não foi possível salvar.')
    },
    onSuccess: () => {
      toast.success('Salvo. Vale a partir do próximo cálculo.')
    },
    onSettled: () => {
      void queryClient.invalidateQueries({ queryKey: ['warehouses', companyId] })
    },
  })

  return (
    <div className="space-y-6">
      {/* Sem `h1`: o título e as abas são do `SettingsHub`. */}
      <p className="max-w-2xl text-sm text-muted-foreground">
        Marque quais depósitos contam como estoque disponível no cálculo de reposição.
        Mudanças valem a partir do próximo cálculo.
      </p>

      {isLoading ? <LoadingBlock /> : !warehouses || warehouses.length === 0 ? (
        <Card>
          <CardContent className="py-12 text-center">
            <p className="font-medium">Nenhum depósito ainda</p>
            <p className="text-sm text-muted-foreground">
              Os depósitos aparecem sozinhos quando a integração sincroniza o estoque.
            </p>
          </CardContent>
        </Card>
      ) : (
        <Card>
          <CardContent className="space-y-4 pt-6">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Depósito</TableHead>
                  <TableHead className="text-right">Peças</TableHead>
                  <TableHead className="text-right">Reservadas</TableHead>
                  <TableHead className="text-right">Disponível p/ venda</TableHead>
                  <TableHead className="text-right">Conta como disponível</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {warehouses.map((w) => {
                  const t = pieces?.get(w.id)
                  return (
                    <TableRow key={w.id}>
                      <TableCell className="font-medium">{w.name}</TableCell>
                      <TableCell className="text-right tabular-nums text-muted-foreground">
                        {t ? formatInt(t.saldo) : pieces ? '0' : '…'}
                      </TableCell>
                      <TableCell className="text-right tabular-nums text-muted-foreground">
                        {t ? formatInt(t.reservado) : pieces ? '0' : '…'}
                      </TableCell>
                      <TableCell className="text-right tabular-nums">
                        {t ? formatInt(t.saldo - t.reservado) : pieces ? '0' : '…'}
                      </TableCell>
                      <TableCell className="text-right">
                        <Switch
                          checked={w.include_in_available}
                          disabled={toggle.isPending}
                          aria-label={`Contar ${w.name} como disponível`}
                          onCheckedChange={(value) => toggle.mutate({ id: w.id, value })}
                        />
                      </TableCell>
                    </TableRow>
                  )
                })}
              </TableBody>
            </Table>

            <StockBasisToggle />
          </CardContent>
        </Card>
      )}
    </div>
  )
}
