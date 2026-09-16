import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { supabase } from '@/lib/supabase'
import { useCompany } from '@/contexts/CompanyContext'
import type { AppRole, Invitation, TeamMember } from '@/types/database'

/** Quem já está dentro. Vem por RPC porque `profiles` só deixa ver a si mesmo. */
export function useTeamMembers() {
  const { companyId } = useCompany()

  return useQuery({
    queryKey: ['team-members', companyId],
    enabled: !!companyId,
    queryFn: async (): Promise<TeamMember[]> => {
      const { data, error } = await supabase.rpc('company_members_list', {
        _company_id: companyId!,
      })
      if (error) throw error
      return (data ?? []) as TeamMember[]
    },
  })
}

/** Convites que ainda não viraram membro. */
export function usePendingInvites() {
  const { companyId } = useCompany()

  return useQuery({
    queryKey: ['invitations', companyId],
    enabled: !!companyId,
    queryFn: async (): Promise<Invitation[]> => {
      const { data, error } = await supabase
        .from('company_invitations')
        .select('id, email, role, expires_at, created_at')
        .eq('company_id', companyId!)
        .is('accepted_at', null)
        .order('created_at', { ascending: false })
      if (error) throw error
      return (data ?? []) as Invitation[]
    },
  })
}

/**
 * Cria (ou substitui) o convite e devolve o token em texto puro.
 *
 * Esta é a única vez que o token existe fora do hash. Convidar de novo o mesmo
 * e-mail gera outro e mata o anterior — é o botão de "reenviar".
 */
export function useCreateInvite() {
  const { companyId } = useCompany()
  const qc = useQueryClient()

  return useMutation({
    mutationFn: async (v: { email: string; role: AppRole }): Promise<string> => {
      const { data, error } = await supabase.rpc('invitation_create', {
        _company_id: companyId,
        _email: v.email,
        _role: v.role,
      })
      if (error) throw error
      return data as string
    },
    onSuccess: () => qc.invalidateQueries({ queryKey: ['invitations', companyId] }),
  })
}

export function useRevokeInvite() {
  const { companyId } = useCompany()
  const qc = useQueryClient()

  return useMutation({
    mutationFn: async (id: string) => {
      const { error } = await supabase.rpc('invitation_revoke', { _id: id })
      if (error) throw error
    },
    onSuccess: () => qc.invalidateQueries({ queryKey: ['invitations', companyId] }),
  })
}
