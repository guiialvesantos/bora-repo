import { createContext, useCallback, useContext, useEffect, useState } from 'react'
import type { ReactNode } from 'react'
import { useQuery } from '@tanstack/react-query'
import { supabase } from '@/lib/supabase'
import { useAuth } from '@/contexts/AuthContext'
import type { AppRole, Company, Membership, Profile } from '@/types/database'

const STORAGE_KEY = 'stock:company_id'

const WRITE_ROLES: AppRole[] = ['owner', 'gestor', 'operador']

interface CompanyContextValue {
  profile: Profile | null
  memberships: Membership[]
  company: Company | null
  companyId: string | null
  role: AppRole | null
  canWrite: boolean
  loading: boolean
  /** autenticado, carregado, e sem nenhuma empresa — convite pendente. */
  needsCompany: boolean
  selectCompany: (id: string) => void
  /** Devolve a promise: quem cria empresa espera a lista antes de selecionar. */
  refetch: () => Promise<unknown>
}

const CompanyContext = createContext<CompanyContextValue | undefined>(undefined)

export function CompanyProvider({ children }: { children: ReactNode }) {
  const { user } = useAuth()
  const [selectedId, setSelectedId] = useState<string | null>(() =>
    typeof localStorage === 'undefined' ? null : localStorage.getItem(STORAGE_KEY),
  )

  const query = useQuery({
    queryKey: ['company-context', user?.id],
    enabled: !!user,
    queryFn: async (): Promise<{ profile: Profile | null; memberships: Membership[] }> => {
      const [profileRes, memberRes] = await Promise.all([
        supabase.from('profiles').select('*').eq('id', user!.id).maybeSingle(),
        supabase
          .from('company_members')
          .select('role, company:companies(*)')
          .eq('user_id', user!.id),
      ])

      if (memberRes.error) throw memberRes.error

      const rows = (memberRes.data ?? []) as unknown as { role: AppRole; company: Company }[]
      const memberships = rows
        .filter((r) => !!r.company)
        .sort((a, b) => a.company.name.localeCompare(b.company.name, 'pt-BR'))

      return { profile: (profileRes.data as Profile | null) ?? null, memberships }
    },
  })

  const memberships = query.data?.memberships ?? []

  // Se a seleção guardada não existe mais (perdeu acesso), cai na primeira.
  const active =
    memberships.find((m) => m.company.id === selectedId) ?? memberships[0] ?? null

  useEffect(() => {
    if (active && active.company.id !== selectedId) {
      setSelectedId(active.company.id)
      localStorage.setItem(STORAGE_KEY, active.company.id)
    }
  }, [active, selectedId])

  const selectCompany = useCallback((id: string) => {
    setSelectedId(id)
    localStorage.setItem(STORAGE_KEY, id)
  }, [])

  const value: CompanyContextValue = {
    profile: query.data?.profile ?? null,
    memberships,
    company: active?.company ?? null,
    companyId: active?.company.id ?? null,
    role: active?.role ?? null,
    canWrite: !!active && WRITE_ROLES.includes(active.role),
    loading: query.isLoading,
    needsCompany: !!user && !query.isLoading && memberships.length === 0,
    selectCompany,
    refetch: () => query.refetch(),
  }

  return <CompanyContext.Provider value={value}>{children}</CompanyContext.Provider>
}

// eslint-disable-next-line react-refresh/only-export-components
export function useCompany() {
  const ctx = useContext(CompanyContext)
  if (!ctx) throw new Error('useCompany deve ser usado dentro de <CompanyProvider>')
  return ctx
}
