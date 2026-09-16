import type { AppRole } from '@/types/database'

/**
 * O que cada papel alcança, em português e conferido contra as políticas de
 * RLS — não contra a intenção de quem escreveu o enum. Quem convida escolhe
 * pelo rótulo; se o rótulo mentir, o convite dá acesso errado.
 */
export const ROLES: { value: AppRole; label: string; hint: string }[] = [
  {
    value: 'owner',
    label: 'Dono',
    hint: 'Tudo. É o único que edita a empresa, mexe em membros e convida outro dono.',
  },
  {
    value: 'gestor',
    label: 'Gestor',
    hint: 'Publica parâmetros, conecta integrações e convida gente. Não mexe em membros.',
  },
  {
    value: 'operador',
    label: 'Operador',
    hint: 'O dia a dia: importa, marca fora de coleção, gera pedido. Não muda parâmetro.',
  },
  { value: 'leitor', label: 'Leitor', hint: 'Só lê. Nenhuma tela grava.' },
]

export function roleLabel(role: AppRole): string {
  return ROLES.find((r) => r.value === role)?.label ?? role
}
