import { useMemo, useState } from 'react'
import { toast } from 'sonner'
import { supabase } from '@/lib/supabase'
import { useCompany } from '@/contexts/CompanyContext'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'

// Espelho do CHECK do banco (0001): ^[a-z0-9][a-z0-9-]{1,48}[a-z0-9]$
const SLUG_RE = /^[a-z0-9][a-z0-9-]{1,48}[a-z0-9]$/

function slugify(name: string) {
  return name
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 50)
    .replace(/-+$/g, '')
}

export function NewCompanyDialog({
  open,
  onOpenChange,
}: {
  open: boolean
  onOpenChange: (open: boolean) => void
}) {
  const { selectCompany, refetch } = useCompany()
  const [name, setName] = useState('')
  const [saving, setSaving] = useState(false)

  const slug = useMemo(() => slugify(name), [name])
  const valid = SLUG_RE.test(slug)

  async function create() {
    setSaving(true)
    // `create_company` é atômico: cria a empresa e já te insere como owner.
    // O trigger `companies_seed_params` semeia os parâmetros padrão — a
    // empresa nasce pronta para importar dados.
    const { data, error } = await supabase.rpc('create_company', {
      _name: name.trim(),
      _slug: slug,
    })
    setSaving(false)
    if (error) {
      toast.error(
        error.code === '23505'
          ? 'Já existe uma empresa com esse identificador — use outro nome.'
          : error.message,
      )
      return
    }
    // Ordem importa: selecionar antes do refetch perde a corrida para o
    // fallback do CompanyContext (id fora das memberships → volta à primeira).
    await refetch()
    selectCompany(data as string)
    toast.success(`Empresa "${name.trim()}" criada.`)
    setName('')
    onOpenChange(false)
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>Nova empresa</DialogTitle>
          <DialogDescription>
            Você entra como dona/dono, com os parâmetros padrão de reposição já
            configurados. Os dados (produtos, vendas, estoque) começam vazios.
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-2">
          <Label htmlFor="company-name">Nome</Label>
          <Input
            id="company-name"
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="Ex.: Triana Semijoias"
            autoFocus
            onKeyDown={(e) => {
              if (e.key === 'Enter' && valid && !saving) void create()
            }}
          />
          {name.trim() && (
            <p className="text-xs text-muted-foreground">
              Identificador: <span className="font-mono">{slug || '—'}</span>
              {!valid && ' (mínimo 3 letras ou números)'}
            </p>
          )}
        </div>

        <DialogFooter>
          <Button variant="ghost" onClick={() => onOpenChange(false)} disabled={saving}>
            Cancelar
          </Button>
          <Button onClick={() => void create()} disabled={!valid || saving}>
            {saving ? 'Criando…' : 'Criar empresa'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
