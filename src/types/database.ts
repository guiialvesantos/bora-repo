export type AppRole = 'owner' | 'gestor' | 'operador' | 'leitor'

export interface Company {
  id: string
  name: string
  slug: string
  timezone: string
  currency: string
  created_at: string
}

export interface Profile {
  id: string
  full_name: string | null
  avatar_url: string | null
  created_at: string
}

export interface CompanyMember {
  company_id: string
  user_id: string
  role: AppRole
  created_at: string
}

/** Uma empresa do usuário, já com o papel dele dentro dela. */
export interface Membership {
  company: Company
  role: AppRole
}

/** Linha de `company_members_list()` — membro já com e-mail e nome resolvidos. */
export interface TeamMember {
  user_id: string
  email: string
  full_name: string | null
  role: AppRole
  created_at: string
}

/**
 * Convite pendente. Sem `token_hash`: a tela não tem o que fazer com ele, e
 * uma coluna a menos trafegando é uma coluna a menos para vazar em log.
 */
export interface Invitation {
  id: string
  email: string
  role: AppRole
  expires_at: string
  created_at: string
}
