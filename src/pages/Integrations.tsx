import { useEffect, useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { toast } from 'sonner'
import {
  ArrowLeft, CheckCircle2, ChevronDown, ChevronRight, CircleSlash, Copy, Loader2,
  Plus, RefreshCw, Warehouse, Webhook, XCircle,
} from 'lucide-react'
import olistLogo from '@/assets/olist-logo.svg'
import {
  useIntegrationConnection, useSyncRuns, useTinyConnect,
  type IntegrationConnection,
} from '@/hooks/useIntegrations'
import { useCompany } from '@/contexts/CompanyContext'
import { usePublishParams, useReplenishmentParams } from '@/hooks/useReplenishmentParams'
import { supabase } from '@/lib/supabase'
import { fetchAllRows } from '@/lib/paging'
import { formatInt } from '@/lib/money'
import { Switch } from '@/components/ui/switch'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import {
  Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle,
} from '@/components/ui/dialog'
import {
  Table, TableBody, TableCell, TableHead, TableHeader, TableRow,
} from '@/components/ui/table'

/** URL que o usuário cadastra ao criar o aplicativo (API v3) no painel do Tiny. */
const OAUTH_REDIRECT_URL = `${import.meta.env.VITE_SUPABASE_URL}/functions/v1/tiny-oauth/callback`

type Provider = 'tiny_v2' | 'tiny_v3'

const PROVIDER_META: Record<Provider, { title: string; subtitle: string }> = {
  tiny_v2: {
    title: 'Tiny — API v2 (token)',
    subtitle: 'Conexão por token. Sincroniza produtos, estoque e pedidos.',
  },
  tiny_v3: {
    title: 'Tiny — API v3 (aplicativo)',
    subtitle: 'Conexão OAuth por aplicativo criado no painel do Tiny.',
  },
}

function dt(v: string | null) {
  if (!v) return '—'
  return new Date(v).toLocaleString('pt-BR', { dateStyle: 'short', timeStyle: 'medium' })
}

function copy(value: string, msg: string) {
  void navigator.clipboard.writeText(value)
  toast.success(msg)
}

const RUN_STATUS_LABEL: Record<string, string> = {
  running: 'Em andamento', done: 'Concluído', paused: 'Pausado (retoma sozinho)', error: 'Erro',
}

function StatusBadge({ conn }: { conn: IntegrationConnection }) {
  if (conn.status === 'connected') {
    return (
      <Badge variant="outline" className="gap-1 text-success-700">
        <CheckCircle2 className="h-3 w-3" /> Conectado
      </Badge>
    )
  }
  if (conn.status === 'error') {
    return (
      <Badge variant="destructive" className="gap-1">
        <XCircle className="h-3 w-3" /> Erro
      </Badge>
    )
  }
  return <Badge variant="secondary">Desconectado</Badge>
}

/** Campo somente-leitura com botão de copiar — usado para URLs de webhook/redirect. */
function CopyField({ label, value, hint }: { label: string; value: string; hint?: string }) {
  return (
    <div className="space-y-1.5">
      <Label>{label}</Label>
      <div className="flex gap-2">
        <Input
          readOnly
          className="font-mono text-xs"
          value={value}
          onFocus={(e) => e.currentTarget.select()}
        />
        <Button
          variant="outline"
          size="icon"
          className="shrink-0"
          aria-label={`Copiar ${label}`}
          onClick={() => copy(value, 'Copiado.')}
        >
          <Copy className="h-4 w-4" />
        </Button>
      </div>
      {hint && <p className="text-xs text-muted-foreground">{hint}</p>}
    </div>
  )
}

// ============================================================================
// Card de uma integração já adicionada
// ============================================================================

function ConnectionCard({
  provider, conn, onReconnect,
}: {
  provider: Provider
  conn: IntegrationConnection
  onReconnect: () => void
}) {
  const tiny = useTinyConnect()
  const { data: runs } = useSyncRuns(provider === 'tiny_v2' ? conn.id : null)
  const [showTech, setShowTech] = useState(false)
  const [showRuns, setShowRuns] = useState(false)
  const meta = PROVIDER_META[provider]
  const connected = conn.status === 'connected'
  const webhookUrl = `${import.meta.env.VITE_SUPABASE_URL}/functions/v1/tiny-webhook/${conn.webhook_token}`

  function run(action: 'test' | 'sync_now' | 'disconnect' | 'oauth_test' | 'oauth_disconnect', ok: string) {
    tiny.mutate({ action }, {
      onSuccess: () => toast.success(ok),
      onError: (e) => toast.error(e.message),
    })
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2 text-base">
          <img src={olistLogo} alt="Olist" className="h-5 w-auto" /> {meta.title}
          <StatusBadge conn={conn} />
        </CardTitle>
        <CardDescription>{meta.subtitle}</CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        {conn.last_error && (
          <div className="flex items-start gap-2 rounded-md border border-error-300 bg-error-100 p-3 text-sm">
            <CircleSlash className="mt-0.5 h-4 w-4 shrink-0 text-destructive" />
            <span>{conn.last_error}</span>
          </div>
        )}

        <div className="flex flex-wrap items-center gap-2">
          {connected ? (
            <>
              <Button
                size="sm" variant="outline" disabled={tiny.isPending}
                onClick={() => run(
                  provider === 'tiny_v2' ? 'test' : 'oauth_test',
                  provider === 'tiny_v2' ? 'Token ainda válido.' : 'Conexão v3 funcionando.',
                )}
              >
                Testar conexão
              </Button>
              {provider === 'tiny_v2' && (
                <Button size="sm" disabled={tiny.isPending} onClick={() => run('sync_now', 'Sincronização enfileirada.')}>
                  <RefreshCw className="h-3.5 w-3.5" /> Sincronizar agora
                </Button>
              )}
              <Button
                size="sm" variant="ghost" className="text-destructive" disabled={tiny.isPending}
                onClick={() => run(
                  provider === 'tiny_v2' ? 'disconnect' : 'oauth_disconnect',
                  'Desconectado. Os dados já sincronizados permanecem.',
                )}
              >
                Desconectar
              </Button>
              {conn.connected_at && (
                <span className="text-xs text-muted-foreground">
                  Conectado em {dt(conn.connected_at)}
                </span>
              )}
            </>
          ) : (
            <Button size="sm" onClick={onReconnect} disabled={tiny.isPending}>
              Reconectar
            </Button>
          )}
        </div>

        {/* Dados técnicos ficam escondidos por padrão — só quem precisa abre. */}
        <div className="rounded-lg border border-border">
          <button
            type="button"
            className="flex w-full items-center gap-2 px-3 py-2 text-sm font-medium hover:bg-muted/50"
            onClick={() => setShowTech((v) => !v)}
          >
            {showTech ? <ChevronDown className="h-4 w-4" /> : <ChevronRight className="h-4 w-4" />}
            <Webhook className="h-4 w-4 text-muted-foreground" /> Webhook e dados técnicos
          </button>
          {showTech && (
            <div className="space-y-4 border-t border-border p-3">
              <CopyField
                label="URL do webhook (receber pedidos e estoque)"
                value={webhookUrl}
                hint="Cadastre esta URL no Tiny em Configurações → Geral → API Web Services → Avisos automáticos (webhooks), para pedidos e estoque. Cada evento recebido entra na fila e é sincronizado em segundos."
              />
              {provider === 'tiny_v3' && (
                <CopyField
                  label="URL de redirecionamento (OAuth)"
                  value={OAUTH_REDIRECT_URL}
                  hint="É a URL cadastrada no aplicativo criado no painel do Tiny."
                />
              )}
            </div>
          )}
        </div>

        {provider === 'tiny_v2' && connected && (
          <div className="rounded-lg border border-border">
            <button
              type="button"
              className="flex w-full items-center gap-2 px-3 py-2 text-sm font-medium hover:bg-muted/50"
              onClick={() => setShowRuns((v) => !v)}
            >
              {showRuns ? <ChevronDown className="h-4 w-4" /> : <ChevronRight className="h-4 w-4" />}
              <RefreshCw className="h-4 w-4 text-muted-foreground" /> Últimas sincronizações
            </button>
            {showRuns && (
              <div className="border-t border-border p-3">
                {!runs || runs.length === 0 ? (
                  <p className="text-sm text-muted-foreground">Nenhuma sincronização ainda.</p>
                ) : (
                  <Table>
                    <TableHeader>
                      <TableRow>
                        <TableHead>Situação</TableHead>
                        <TableHead className="text-right">Processados</TableHead>
                        <TableHead>Início</TableHead>
                        <TableHead>Fim</TableHead>
                        <TableHead>Erro</TableHead>
                      </TableRow>
                    </TableHeader>
                    <TableBody>
                      {runs.map((r) => (
                        <TableRow key={r.id}>
                          <TableCell>
                            <Badge
                              variant={r.status === 'error' ? 'destructive' : 'outline'}
                              className={r.status === 'done' ? 'text-success-700' : undefined}
                            >
                              {RUN_STATUS_LABEL[r.status] ?? r.status}
                            </Badge>
                          </TableCell>
                          <TableCell className="text-right tabular-nums">{formatInt(r.processed)}</TableCell>
                          <TableCell className="tabular-nums">{dt(r.started_at)}</TableCell>
                          <TableCell className="tabular-nums">{dt(r.finished_at)}</TableCell>
                          <TableCell className="max-w-xs truncate text-muted-foreground">{r.error ?? '—'}</TableCell>
                        </TableRow>
                      ))}
                    </TableBody>
                  </Table>
                )}
              </div>
            )}
          </div>
        )}
      </CardContent>
    </Card>
  )
}

// ============================================================================
// Depósitos — quais contam como estoque disponível
// ============================================================================

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
 */
function WarehousesCard() {
  const { companyId } = useCompany()
  const queryClient = useQueryClient()

  const { data: warehouses } = useQuery({
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

  if (!warehouses || warehouses.length === 0) return null

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2 text-base">
          <Warehouse className="h-4 w-4 text-muted-foreground" /> Depósitos
        </CardTitle>
        <CardDescription>
          Marque quais depósitos contam como estoque disponível no cálculo de reposição.
          Mudanças valem a partir do próximo cálculo.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
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
  )
}

// ============================================================================
// Diálogo de adicionar integração: catálogo → formulário do provedor
// ============================================================================

function AddIntegrationDialog({
  open, onOpenChange, available, initialProvider,
}: {
  open: boolean
  onOpenChange: (v: boolean) => void
  available: Provider[]
  initialProvider: Provider | null
}) {
  const tiny = useTinyConnect()
  const [provider, setProvider] = useState<Provider | null>(initialProvider)
  const [token, setToken] = useState('')
  const [clientId, setClientId] = useState('')
  const [clientSecret, setClientSecret] = useState('')

  // Reabre sempre no passo pedido (catálogo, ou direto no form ao reconectar).
  useEffect(() => {
    if (open) setProvider(initialProvider)
  }, [open, initialProvider])

  function handleConnectV2() {
    if (!token.trim()) { toast.error('Cole o token da API v2 do Tiny.'); return }
    tiny.mutate(
      { action: 'connect', token: token.trim() },
      {
        onSuccess: () => {
          setToken('')
          toast.success('Conectado. Sincronizando produtos e estoque…')
          onOpenChange(false)
        },
        onError: (e) => toast.error(e.message),
      },
    )
  }

  function handleConnectV3() {
    if (!clientId.trim() || !clientSecret.trim()) {
      toast.error('Preencha o client_id e o client_secret do aplicativo.')
      return
    }
    tiny.mutate(
      { action: 'oauth_init', clientId: clientId.trim(), clientSecret: clientSecret.trim() },
      {
        onSuccess: (data) => {
          const url = (data as { authorizeUrl?: string })?.authorizeUrl
          if (!url) { toast.error('Resposta sem URL de autorização.'); return }
          // Sai da página: o consentimento acontece no accounts.tiny.com.br e
          // o callback traz de volta para /integracoes.
          window.location.href = url
        },
        onError: (e) => toast.error(e.message),
      },
    )
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-lg">
        {provider === null ? (
          <>
            <DialogHeader>
              <DialogTitle>Adicionar integração</DialogTitle>
              <DialogDescription>Escolha o que você quer conectar.</DialogDescription>
            </DialogHeader>
            <div className="space-y-2">
              {available.length === 0 && (
                <p className="text-sm text-muted-foreground">
                  Todas as integrações disponíveis já foram adicionadas.
                </p>
              )}
              {available.map((p) => (
                <button
                  key={p}
                  type="button"
                  className="flex w-full items-center gap-3 rounded-lg border border-border p-3 text-left hover:border-brand-600 hover:bg-mono-100"
                  onClick={() => setProvider(p)}
                >
                  <img src={olistLogo} alt="Olist" className="h-6 w-auto" />
                  <span className="min-w-0">
                    <span className="block text-sm font-medium">{PROVIDER_META[p].title}</span>
                    <span className="block text-xs text-muted-foreground">{PROVIDER_META[p].subtitle}</span>
                  </span>
                </button>
              ))}
            </div>
          </>
        ) : provider === 'tiny_v2' ? (
          <>
            <DialogHeader>
              <DialogTitle className="flex items-center gap-2">
                <img src={olistLogo} alt="Olist" className="h-5 w-auto" /> Tiny — API v2
              </DialogTitle>
              <DialogDescription>
                Gere o token no Tiny em Configurações → Geral → API Web Services. O token fica
                criptografado e nunca volta a aparecer depois de salvo.
              </DialogDescription>
            </DialogHeader>
            <div className="space-y-1.5">
              <Label htmlFor="tiny-token">Token da API v2</Label>
              <Input
                id="tiny-token"
                name="tiny-api-token"
                type="text"
                autoComplete="off"
                autoCorrect="off"
                autoCapitalize="off"
                spellCheck={false}
                data-1p-ignore
                data-lpignore="true"
                className="font-mono"
                placeholder="Cole o token gerado no Tiny"
                value={token}
                onChange={(e) => setToken(e.target.value)}
              />
            </div>
            <div className="flex justify-between gap-2">
              <Button variant="ghost" onClick={() => setProvider(null)}>
                <ArrowLeft className="h-4 w-4" /> Voltar
              </Button>
              <Button onClick={handleConnectV2} disabled={tiny.isPending}>
                {tiny.isPending && <Loader2 className="h-4 w-4 animate-spin" />}
                Conectar
              </Button>
            </div>
          </>
        ) : (
          <>
            <DialogHeader>
              <DialogTitle className="flex items-center gap-2">
                <img src={olistLogo} alt="Olist" className="h-5 w-auto" /> Tiny — API v3 (aplicativo)
              </DialogTitle>
              <DialogDescription>
                Crie um aplicativo no painel do Tiny em{' '}
                <span className="font-medium text-foreground">
                  Configurações → Geral → Aplicativos → + novo aplicativo
                </span>
                , com permissão de leitura em produtos, estoque e pedidos. Cadastre a URL de
                redirecionamento abaixo no aplicativo e copie as chaves de acesso para cá. O
                client_secret fica criptografado e nunca volta a aparecer.
              </DialogDescription>
            </DialogHeader>
            <div className="space-y-4">
              <CopyField label="URL de redirecionamento" value={OAUTH_REDIRECT_URL} />
              <div className="space-y-1.5">
                <Label htmlFor="v3-client-id">client_id</Label>
                <Input
                  id="v3-client-id"
                  autoComplete="off"
                  spellCheck={false}
                  data-1p-ignore
                  data-lpignore="true"
                  className="font-mono"
                  placeholder="Chave de acesso do aplicativo"
                  value={clientId}
                  onChange={(e) => setClientId(e.target.value)}
                />
              </div>
              <div className="space-y-1.5">
                <Label htmlFor="v3-client-secret">client_secret</Label>
                <Input
                  id="v3-client-secret"
                  type="password"
                  autoComplete="off"
                  spellCheck={false}
                  data-1p-ignore
                  data-lpignore="true"
                  className="font-mono"
                  placeholder="Segredo do aplicativo"
                  value={clientSecret}
                  onChange={(e) => setClientSecret(e.target.value)}
                />
              </div>
            </div>
            <div className="flex justify-between gap-2">
              <Button variant="ghost" onClick={() => setProvider(null)}>
                <ArrowLeft className="h-4 w-4" /> Voltar
              </Button>
              <Button onClick={handleConnectV3} disabled={tiny.isPending}>
                {tiny.isPending && <Loader2 className="h-4 w-4 animate-spin" />}
                Conectar com o Tiny
              </Button>
            </div>
          </>
        )}
      </DialogContent>
    </Dialog>
  )
}

// ============================================================================
// Página
// ============================================================================

export default function Integrations() {
  const { data: v2conn, isLoading: v2Loading } = useIntegrationConnection('tiny_v2')
  const { data: v3conn, isLoading: v3Loading } = useIntegrationConnection('tiny_v3')
  const [dialogOpen, setDialogOpen] = useState(false)
  const [dialogProvider, setDialogProvider] = useState<Provider | null>(null)

  // Volta do consentimento no Tiny: o callback redireciona para cá com
  // ?tiny_v3=connected|error. Só avisa e limpa a URL — o estado real vem do
  // banco pela query da conexão.
  useEffect(() => {
    const params = new URLSearchParams(window.location.search)
    const result = params.get('tiny_v3')
    if (!result) return
    if (result === 'connected') toast.success('Aplicativo do Tiny autorizado.')
    else toast.error('A autorização no Tiny falhou — veja o motivo no card da API v3.')
    params.delete('tiny_v3')
    const rest = params.toString()
    window.history.replaceState(null, '', `${window.location.pathname}${rest ? `?${rest}` : ''}`)
  }, [])

  const loading = v2Loading || v3Loading
  // Uma integração só aparece na lista depois de adicionada (linha no banco).
  const added: { provider: Provider; conn: IntegrationConnection }[] = []
  if (v2conn) added.push({ provider: 'tiny_v2', conn: v2conn })
  if (v3conn) added.push({ provider: 'tiny_v3', conn: v3conn })
  const available = (['tiny_v2', 'tiny_v3'] as Provider[])
    .filter((p) => !added.some((a) => a.provider === p))

  function openAdd(provider: Provider | null) {
    setDialogProvider(provider)
    setDialogOpen(true)
  }

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          {/* Sem `h1`: o título e as abas são do `SettingsHub`. */}
          <p className="max-w-2xl text-sm text-muted-foreground">
            Produtos, estoque e pedidos entram automaticamente pelas integrações conectadas.
          </p>
        </div>
        <Button onClick={() => openAdd(null)}>
          <Plus className="h-4 w-4" /> Adicionar integração
        </Button>
      </div>

      {loading ? null : added.length === 0 ? (
        <Card>
          <CardContent className="flex flex-col items-center gap-3 py-12 text-center">
            <img src={olistLogo} alt="Olist" className="h-8 w-auto opacity-60" />
            <div>
              <p className="font-medium">Nenhuma integração adicionada</p>
              <p className="text-sm text-muted-foreground">
                Conecte o Tiny (Olist) para sincronizar produtos, estoque e pedidos automaticamente.
              </p>
            </div>
            <Button onClick={() => openAdd(null)}>
              <Plus className="h-4 w-4" /> Adicionar integração
            </Button>
          </CardContent>
        </Card>
      ) : (
        added.map(({ provider, conn }) => (
          <ConnectionCard
            key={provider}
            provider={provider}
            conn={conn}
            onReconnect={() => openAdd(provider)}
          />
        ))
      )}

      <WarehousesCard />

      <AddIntegrationDialog
        open={dialogOpen}
        onOpenChange={setDialogOpen}
        available={available}
        initialProvider={dialogProvider}
      />
    </div>
  )
}
