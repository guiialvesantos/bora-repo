const brl = new Intl.NumberFormat('pt-BR', {
  style: 'currency',
  currency: 'BRL',
  minimumFractionDigits: 2,
  maximumFractionDigits: 2,
})

const int = new Intl.NumberFormat('pt-BR', { maximumFractionDigits: 0 })

export function formatBRL(value: number | null | undefined): string {
  return brl.format(value ?? 0)
}

export function formatInt(value: number | null | undefined): string {
  return int.format(value ?? 0)
}

/**
 * Rótulo curto dos gráficos, no mesmo formato da planilha
 * (`=TEXT(B21/1000,"R$  ###.###.### ")&"mil"` → `R$ 259 mil`).
 */
export function formatBRLShort(value: number | null | undefined): string {
  return `R$ ${int.format(Math.round((value ?? 0) / 1000))} mil`
}

/**
 * Igual ao curto, mas vira milhão acima de 1 mi. A régua de um gráfico que
 * chega a seis milhões não pode dizer `R$ 6.000 mil` — são três ordens de
 * grandeza encavaladas no mesmo rótulo.
 */
export function formatBRLCompact(value: number | null | undefined): string {
  const v = value ?? 0
  const abs = Math.abs(v)
  if (abs >= 1_000_000) {
    return `R$ ${(v / 1_000_000).toLocaleString('pt-BR', { maximumFractionDigits: 1 })} mi`
  }
  if (abs >= 1_000) return `R$ ${int.format(Math.round(v / 1000))} mil`
  return `R$ ${int.format(Math.round(v))}`
}
