import { useEffect, useState } from 'react'
import { toast } from 'sonner'
import {
  ArrowLeft, CheckCircle2, ChevronDown, ChevronRight, CircleSlash, Copy, Loader2,
  Pencil, Plus, RefreshCw, Store, Trash2, Webhook, XCircle,
} from 'lucide-react'
import olistLogo from '@/assets/olist-logo.svg'
import trierLogo from '@/assets/trier-logo.png'
import {
  useIntegrationConnection, useSyncRuns, useTinyConnect, useTrierConnect, useTrierConnectors,
  type IntegrationConnection, type TrierConnector,
} from '@/hooks/useIntegrations'
import { formatInt } from '@/lib/money'
import { LoadingBlock } from '@/components/brand/Logo'
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

const TRIER_META = {
  title: 'Trier Sistemas (SGF)',
  subtitle: 'Farmácias. Uma chave por loja, lida por um conector dentro da farmácia.',
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
  const [editing, setEditing] = useState(false)
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

  function remove() {
    if (!window.confirm(
      `Excluir a integração ${meta.title}? Ela sai da lista e as credenciais são apagadas. `
      + 'Produtos, estoque e vendas já sincronizados permanecem.',
    )) return
    tiny.mutate({ action: 'remove', provider }, {
      onSuccess: () => toast.success('Integração excluída.'),
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
          <Button
            size="sm" variant="outline" disabled={tiny.isPending}
            onClick={() => setEditing((v) => !v)}
          >
            <Pencil className="h-3.5 w-3.5" /> {editing ? 'Fechar' : 'Editar'}
          </Button>
          <Button
            size="sm" variant="ghost" className="text-destructive"
            disabled={tiny.isPending} onClick={remove}
          >
            <Trash2 className="h-3.5 w-3.5" /> Excluir
          </Button>
        </div>

        {/* A URL do webhook é cadastrada uma vez, no dia em que se conecta, e
            depois nunca mais. Deixá-la sempre à mostra — mesmo dobrada — fazia
            a tela parecer ter mais configuração do que tem. Agora é preciso
            pedir para ver. */}
        {editing && (
          <div className="space-y-4 rounded-lg border border-border p-3">
            <p className="flex items-center gap-2 text-sm font-medium">
              <Webhook className="h-4 w-4 text-muted-foreground" /> Webhook e dados técnicos
            </p>
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
// Trier Sistemas — uma chave por loja, lida pelo conector dentro da farmácia
// ============================================================================

/** Endereço que o conector instalado na farmácia usa para enviar os dados. */
const TRIER_INGEST_URL = `${import.meta.env.VITE_SUPABASE_URL}/functions/v1/trier-ingest`

/** Depois disso sem notícia, o conector daquela loja provavelmente parou. */
const TRIER_STALE_MS = 60 * 60 * 1000

/**
 * O diálogo tem dois estados porque a chave aparece **uma única vez**: só
 * guardamos o hash, então reabrir a tela depois não a recupera. Fechar sem
 * copiar significa revogar e gerar outra.
 */
function TrierStoreDialog({
  open, onOpenChange,
}: {
  open: boolean
  onOpenChange: (v: boolean) => void
}) {
  const trier = useTrierConnect()
  const [label, setLabel] = useState('')
  const [issuedKey, setIssuedKey] = useState<string | null>(null)

  // Limpa ao fechar (e não ao abrir): a chave não pode sobreviver escondida no
  // estado esperando a próxima abertura do diálogo.
  function handleOpenChange(v: boolean) {
    if (!v) { setLabel(''); setIssuedKey(null) }
    onOpenChange(v)
  }

  function handleIssue() {
    if (!label.trim()) { toast.error('Dê um nome para a loja.'); return }
    trier.mutate({ action: 'issue', label: label.trim() }, {
      onSuccess: (data) => {
        const key = (data as { key?: string })?.key
        if (!key) { toast.error('A resposta veio sem a chave. Tente de novo.'); return }
        setIssuedKey(key)
      },
      onError: (e) => toast.error(e.message),
    })
  }

  return (
    <Dialog open={open} onOpenChange={handleOpenChange}>
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <img src={trierLogo} alt="Trier Sistemas" className="h-5 w-auto" /> Adicionar loja
          </DialogTitle>
          <DialogDescription>
            {issuedKey
              ? 'Copie a chave agora e cole no arquivo de configuração do conector, na farmácia.'
              : 'Cada instalação do SGF é uma loja e tem a sua própria chave e o seu próprio depósito no BoraRepô.'}
          </DialogDescription>
        </DialogHeader>

        {issuedKey ? (
          <div className="space-y-4">
            <CopyField
              label="connectorKey"
              value={issuedKey}
              hint="Esta chave não volta a aparecer. Se perder, revogue esta loja e gere outra."
            />
            <CopyField
              label="ingestUrl"
              value={TRIER_INGEST_URL}
              hint="Os dois valores vão no borarepo.config.json, na pasta do conector."
            />
            <div className="flex justify-end">
              <Button onClick={() => handleOpenChange(false)}>Já copiei</Button>
            </div>
          </div>
        ) : (
          <div className="space-y-4">
            <div className="space-y-1.5">
              <Label htmlFor="trier-label">Nome da loja</Label>
              <Input
                id="trier-label"
                autoComplete="off"
                spellCheck={false}
                placeholder="Ex.: Matriz — Centro"
                value={label}
                onChange={(e) => setLabel(e.target.value)}
              />
              <p className="text-xs text-muted-foreground">
                Vira também o nome do depósito desta loja, em Depósitos.
              </p>
            </div>
            <div className="flex justify-end">
              <Button onClick={handleIssue} disabled={trier.isPending}>
                {trier.isPending && <Loader2 className="h-4 w-4 animate-spin" />}
                Gerar chave
              </Button>
            </div>
          </div>
        )}
      </DialogContent>
    </Dialog>
  )
}

/**
 * `now` vem do `dataUpdatedAt` da consulta, não de `Date.now()`: a lista
 * recarrega sozinha a cada 30s, então comparar com o instante da busca dá o
 * mesmo resultado e mantém a renderização pura (o vermelho não pisca sozinho
 * no meio de um re-render qualquer).
 */
function TrierConnectorRow({ c, now }: { c: TrierConnector; now: number }) {
  const trier = useTrierConnect()
  const seenAt = c.last_seen_at ? new Date(c.last_seen_at).getTime() : null
  const stale = seenAt === null || now - seenAt > TRIER_STALE_MS

  return (
    <TableRow>
      <TableCell className="font-medium">{c.label}</TableCell>
      <TableCell className="font-mono text-xs text-muted-foreground">{c.key_prefix}…</TableCell>
      <TableCell className="tabular-nums">
        <span className={stale ? 'text-destructive' : undefined}>{dt(c.last_seen_at)}</span>
      </TableCell>
      <TableCell className="text-muted-foreground">{c.last_version ?? '—'}</TableCell>
      <TableCell className="max-w-xs truncate text-muted-foreground">{c.last_error ?? '—'}</TableCell>
      <TableCell className="text-right">
        <Button
          variant="ghost"
          size="icon"
          className="text-destructive"
          disabled={trier.isPending}
          aria-label={`Revogar a chave de ${c.label}`}
          onClick={() => {
            if (!window.confirm(
              `Revogar a chave de "${c.label}"? O conector daquela loja para de enviar dados na hora. Os dados já recebidos permanecem.`,
            )) return
            trier.mutate({ action: 'revoke', connectorId: c.id }, {
              onSuccess: () => toast.success('Chave revogada.'),
              onError: (e) => toast.error(e.message),
            })
          }}
        >
          <Trash2 className="h-4 w-4" />
        </Button>
      </TableCell>
    </TableRow>
  )
}

function TrierCard({ conn, onAddStore }: { conn: IntegrationConnection; onAddStore: () => void }) {
  const trier = useTrierConnect()
  const { data: connectors, dataUpdatedAt } = useTrierConnectors()
  const [editing, setEditing] = useState(false)

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2 text-base">
          <img src={trierLogo} alt="Trier Sistemas" className="h-5 w-auto" /> {TRIER_META.title}
          <StatusBadge conn={conn} />
        </CardTitle>
        <CardDescription>{TRIER_META.subtitle}</CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        {conn.last_error && (
          <div className="flex items-start gap-2 rounded-md border border-error-300 bg-error-100 p-3 text-sm">
            <CircleSlash className="mt-0.5 h-4 w-4 shrink-0 text-destructive" />
            <span>{conn.last_error}</span>
          </div>
        )}

        {!connectors || connectors.length === 0 ? (
          <p className="text-sm text-muted-foreground">
            Nenhuma loja ainda. Gere uma chave e cole no conector instalado na farmácia.
          </p>
        ) : (
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Loja</TableHead>
                <TableHead>Chave</TableHead>
                <TableHead>Última vez visto</TableHead>
                <TableHead>Versão</TableHead>
                <TableHead>Último erro</TableHead>
                <TableHead className="text-right">Revogar</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {connectors.map((c) => <TrierConnectorRow key={c.id} c={c} now={dataUpdatedAt} />)}
            </TableBody>
          </Table>
        )}

        <div className="flex flex-wrap items-center gap-2">
          <Button size="sm" onClick={onAddStore} disabled={trier.isPending}>
            <Store className="h-3.5 w-3.5" /> Adicionar loja
          </Button>
          <Button
            size="sm" variant="ghost" className="text-destructive" disabled={trier.isPending}
            onClick={() => {
              if (!window.confirm(
                'Desconectar a Trier revoga as chaves de todas as lojas. Os dados já recebidos permanecem.',
              )) return
              trier.mutate({ action: 'disconnect' }, {
                onSuccess: () => toast.success('Desconectado. Os dados já sincronizados permanecem.'),
                onError: (e) => toast.error(e.message),
              })
            }}
          >
            Desconectar
          </Button>
          <Button
            size="sm" variant="outline" disabled={trier.isPending}
            onClick={() => setEditing((v) => !v)}
          >
            <Pencil className="h-3.5 w-3.5" /> {editing ? 'Fechar' : 'Editar'}
          </Button>
          <Button
            size="sm" variant="ghost" className="text-destructive" disabled={trier.isPending}
            onClick={() => {
              if (!window.confirm(
                'Excluir a integração Trier Sistemas? Todas as chaves são apagadas junto e os '
                + 'conectores param de enviar. Os depósitos das lojas e os dados já recebidos '
                + 'permanecem.',
              )) return
              trier.mutate({ action: 'remove' }, {
                onSuccess: () => toast.success('Integração excluída.'),
                onError: (e) => toast.error(e.message),
              })
            }}
          >
            <Trash2 className="h-3.5 w-3.5" /> Excluir
          </Button>
          {conn.connected_at && (
            <span className="text-xs text-muted-foreground">
              Primeiro envio recebido em {dt(conn.connected_at)}
            </span>
          )}
        </div>

        {editing && (
          <div className="space-y-4 rounded-lg border border-border p-3">
            <p className="flex items-center gap-2 text-sm font-medium">
              <Webhook className="h-4 w-4 text-muted-foreground" /> Conector e dados técnicos
            </p>
            <CopyField
              label="ingestUrl"
              value={TRIER_INGEST_URL}
              hint="Vai no borarepo.config.json do conector. O conector lê o SGF em http://localhost:4647 dentro da loja e envia para cá por HTTPS — nenhuma porta é aberta na farmácia e o token da Trier não sai de lá."
            />
          </div>
        )}
      </CardContent>
    </Card>
  )
}

// ============================================================================
// Diálogo de adicionar integração: catálogo → formulário do provedor
// ============================================================================

function AddIntegrationDialog({
  open, onOpenChange, available, initialProvider, trierAvailable, onPickTrier,
}: {
  open: boolean
  onOpenChange: (v: boolean) => void
  available: Provider[]
  initialProvider: Provider | null
  trierAvailable: boolean
  onPickTrier: () => void
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
              {available.length === 0 && !trierAvailable && (
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
              {trierAvailable && (
                <button
                  type="button"
                  className="flex w-full items-center gap-3 rounded-lg border border-border p-3 text-left hover:border-brand-600 hover:bg-mono-100"
                  onClick={onPickTrier}
                >
                  <img src={trierLogo} alt="Trier Sistemas" className="h-6 w-auto" />
                  <span className="min-w-0">
                    <span className="block text-sm font-medium">{TRIER_META.title}</span>
                    <span className="block text-xs text-muted-foreground">{TRIER_META.subtitle}</span>
                  </span>
                </button>
              )}
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
  const { data: trierConn, isLoading: trierLoading } = useIntegrationConnection('trier_sgf')
  const [dialogOpen, setDialogOpen] = useState(false)
  const [dialogProvider, setDialogProvider] = useState<Provider | null>(null)
  const [trierStoreOpen, setTrierStoreOpen] = useState(false)

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

  const loading = v2Loading || v3Loading || trierLoading
  // Uma integração só aparece na lista depois de adicionada (linha no banco).
  const added: { provider: Provider; conn: IntegrationConnection }[] = []
  if (v2conn) added.push({ provider: 'tiny_v2', conn: v2conn })
  if (v3conn) added.push({ provider: 'tiny_v3', conn: v3conn })
  const available = (['tiny_v2', 'tiny_v3'] as Provider[])
    .filter((p) => !added.some((a) => a.provider === p))
  const empty = added.length === 0 && !trierConn

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

      {/* Era `null`: enquanto as duas consultas respondiam, a página tinha só o
          cabeçalho e um botão pairando sobre o branco, e logo depois nascia um
          cartão inteiro embaixo. Agora a espera ocupa o lugar que o conteúdo
          vai ocupar, em vez de a página pular. */}
      {loading ? <LoadingBlock /> : empty ? (
        <Card>
          <CardContent className="flex flex-col items-center gap-3 py-12 text-center">
            <div className="flex items-center gap-4 opacity-60">
              <img src={olistLogo} alt="Olist" className="h-8 w-auto" />
              <img src={trierLogo} alt="Trier Sistemas" className="h-8 w-auto" />
            </div>
            <div>
              <p className="font-medium">Nenhuma integração adicionada</p>
              <p className="text-sm text-muted-foreground">
                Conecte o Tiny (Olist) ou a Trier Sistemas para sincronizar produtos, estoque e
                pedidos automaticamente.
              </p>
            </div>
            <Button onClick={() => openAdd(null)}>
              <Plus className="h-4 w-4" /> Adicionar integração
            </Button>
          </CardContent>
        </Card>
      ) : (
        <>
          {added.map(({ provider, conn }) => (
            <ConnectionCard
              key={provider}
              provider={provider}
              conn={conn}
              onReconnect={() => openAdd(provider)}
            />
          ))}
          {trierConn && (
            <TrierCard conn={trierConn} onAddStore={() => setTrierStoreOpen(true)} />
          )}
        </>
      )}

      <AddIntegrationDialog
        open={dialogOpen}
        onOpenChange={setDialogOpen}
        available={available}
        initialProvider={dialogProvider}
        trierAvailable={!trierConn}
        onPickTrier={() => { setDialogOpen(false); setTrierStoreOpen(true) }}
      />
      <TrierStoreDialog open={trierStoreOpen} onOpenChange={setTrierStoreOpen} />
    </div>
  )
}
