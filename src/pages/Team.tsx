import { useState } from 'react'
import { toast } from 'sonner'
import { Check, Copy, Link2, Loader2, Trash2, UserPlus } from 'lucide-react'
import { useCompany } from '@/contexts/CompanyContext'
import {
  useCreateInvite, usePendingInvites, useRevokeInvite, useTeamMembers,
} from '@/hooks/useTeam'
import { ROLES, roleLabel } from '@/lib/roles'
import type { AppRole } from '@/types/database'
import { Button } from '@/components/ui/button'
import { Badge } from '@/components/ui/badge'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import {
  Select, SelectContent, SelectItem, SelectTrigger, SelectValue,
} from '@/components/ui/select'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import {
  Table, TableBody, TableCell, TableHead, TableHeader, TableRow,
} from '@/components/ui/table'

function dmy(iso: string): string {
  return new Date(iso).toLocaleDateString('pt-BR')
}

/**
 * O link do convite, mostrado uma vez só.
 *
 * Fica num bloco destacado e não numa notificação que some sozinha, porque
 * este texto não existe em lugar nenhum além desta tela: o banco só guarda o
 * hash. Some daqui, some de vez — e aí o caminho é gerar outro.
 */
function InviteLink({ url, email }: { url: string; email: string }) {
  const [copied, setCopied] = useState(false)

  async function copy() {
    await navigator.clipboard.writeText(url)
    setCopied(true)
    toast.success('Link copiado')
    setTimeout(() => setCopied(false), 2000)
  }

  return (
    <div className="rounded-sm border border-brand-200 bg-brand-100 p-3">
      <p className="flex items-center gap-1.5 text-body-sm font-medium text-ink">
        <Link2 className="h-3.5 w-3.5" /> Link para {email}
      </p>
      <p className="mt-1 text-xs text-muted-foreground">
        Mande por onde preferir. Ele aparece uma vez: não guardamos o link, só um resumo dele.
        Se perder, gere outro — o anterior deixa de valer.
      </p>
      <div className="mt-2 flex gap-2">
        <Input readOnly value={url} className="font-data text-xs" onFocus={(e) => e.target.select()} />
        <Button variant="secondary" onClick={copy} className="shrink-0">
          {copied ? <Check className="mr-2 h-4 w-4" /> : <Copy className="mr-2 h-4 w-4" />}
          Copiar
        </Button>
      </div>
    </div>
  )
}

export default function Team() {
  const { company, role } = useCompany()
  const members = useTeamMembers()
  const invites = usePendingInvites()
  const create = useCreateInvite()
  const revoke = useRevokeInvite()

  const [email, setEmail] = useState('')
  const [draftRole, setDraftRole] = useState<AppRole>('operador')
  const [link, setLink] = useState<{ url: string; email: string } | null>(null)

  const canInvite = role === 'owner' || role === 'gestor'
  // Gestor não vê "Dono" na lista: o banco recusaria de qualquer jeito, e
  // oferecer uma opção que sempre falha é pior do que não oferecer.
  const options = ROLES.filter((r) => r.value !== 'owner' || role === 'owner')

  async function invite(target: string, targetRole: AppRole) {
    try {
      const token = await create.mutateAsync({ email: target, role: targetRole })
      setLink({ url: `${window.location.origin}/convite/${token}`, email: target.toLowerCase() })
      setEmail('')
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'Não foi possível criar o convite')
    }
  }

  return (
    <div className="space-y-6">
      <div>
        {/* Sem `h1`: o título e as abas são do `SettingsHub`. */}
        <p className="max-w-2xl text-sm text-muted-foreground">
          Quem tem acesso a {company?.name ?? 'esta empresa'}. O convite é um link: quem abrir
          precisa entrar com o e-mail convidado para virar membro.
        </p>
      </div>

      {canInvite && (
        <Card>
          <CardHeader className="pb-3">
            <CardTitle className="text-card-title">Convidar</CardTitle>
            <CardDescription>
              O papel vale só nesta empresa. A mesma pessoa pode ser gestora aqui e leitora na
              outra.
            </CardDescription>
          </CardHeader>
          <CardContent className="space-y-3">
            <form
              className="flex flex-wrap items-end gap-3"
              onSubmit={(e) => {
                e.preventDefault()
                void invite(email, draftRole)
              }}
            >
              <div className="min-w-[16rem] flex-1 space-y-1.5">
                <Label htmlFor="invite-email">E-mail</Label>
                <Input
                  id="invite-email"
                  type="email"
                  required
                  placeholder="pessoa@empresa.com.br"
                  value={email}
                  onChange={(e) => setEmail(e.target.value)}
                />
              </div>
              <div className="w-48 space-y-1.5">
                <Label htmlFor="invite-role">Papel</Label>
                <Select value={draftRole} onValueChange={(v) => setDraftRole(v as AppRole)}>
                  <SelectTrigger id="invite-role">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {options.map((r) => (
                      <SelectItem key={r.value} value={r.value}>{r.label}</SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
              <Button type="submit" disabled={create.isPending}>
                {create.isPending
                  ? <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                  : <UserPlus className="mr-2 h-4 w-4" />}
                Gerar convite
              </Button>
            </form>

            <p className="text-xs text-muted-foreground">
              {ROLES.find((r) => r.value === draftRole)?.hint}
            </p>

            {link && <InviteLink url={link.url} email={link.email} />}
          </CardContent>
        </Card>
      )}

      <Card>
        <CardHeader className="pb-3">
          <CardTitle className="text-card-title">Membros</CardTitle>
          {/* O contador só aparece quando há resposta. Enquanto carrega — ou se
              a consulta falhar — "0 pessoas com acesso" seria uma afirmação
              falsa sobre uma tela de permissões, que é o pior lugar para
              chutar um número. */}
          <CardDescription>
            {members.data
              ? `${members.data.length} ${members.data.length === 1 ? 'pessoa' : 'pessoas'} com acesso.`
              : members.isError
                ? 'Não deu para saber quem tem acesso.'
                : 'Carregando quem tem acesso…'}
          </CardDescription>
        </CardHeader>
        <CardContent>
          {members.isError ? (
            <p className="text-sm text-destructive">
              Não foi possível carregar os membros: {members.error.message}
            </p>
          ) : members.isLoading ? (
            <div className="h-24 animate-pulse rounded-sm bg-surface-inset" />
          ) : (
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>E-mail</TableHead>
                  <TableHead>Nome</TableHead>
                  <TableHead>Papel</TableHead>
                  <TableHead className="text-right">Desde</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {(members.data ?? []).map((m) => (
                  <TableRow key={m.user_id}>
                    <TableCell className="font-medium">{m.email}</TableCell>
                    <TableCell className="text-muted-foreground">{m.full_name ?? '—'}</TableCell>
                    <TableCell><Badge variant="secondary">{roleLabel(m.role)}</Badge></TableCell>
                    <TableCell className="text-right font-data tabular-nums">
                      {dmy(m.created_at)}
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          )}
        </CardContent>
      </Card>

      {canInvite && (invites.data?.length ?? 0) > 0 && (
        <Card>
          <CardHeader className="pb-3">
            <CardTitle className="text-card-title">Convites em aberto</CardTitle>
            <CardDescription>
              Ainda não viraram membro. Expiram sozinhos em 14 dias.
            </CardDescription>
          </CardHeader>
          <CardContent>
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>E-mail</TableHead>
                  <TableHead>Papel</TableHead>
                  <TableHead>Expira</TableHead>
                  <TableHead className="text-right">Ações</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {(invites.data ?? []).map((i) => (
                  <TableRow key={i.id}>
                    <TableCell className="font-medium">{i.email}</TableCell>
                    <TableCell><Badge variant="secondary">{roleLabel(i.role)}</Badge></TableCell>
                    <TableCell className="font-data tabular-nums text-muted-foreground">
                      {dmy(i.expires_at)}
                    </TableCell>
                    <TableCell className="text-right">
                      <Button
                        variant="ghost"
                        size="sm"
                        onClick={() => void invite(i.email, i.role)}
                        disabled={create.isPending}
                      >
                        <Link2 className="mr-2 h-3.5 w-3.5" /> Novo link
                      </Button>
                      <Button
                        variant="ghost"
                        size="sm"
                        onClick={() => {
                          revoke.mutate(i.id, {
                            onSuccess: () => toast.success('Convite revogado'),
                            onError: (e) => toast.error(e.message),
                          })
                        }}
                      >
                        <Trash2 className="mr-2 h-3.5 w-3.5" /> Revogar
                      </Button>
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </CardContent>
        </Card>
      )}
    </div>
  )
}
