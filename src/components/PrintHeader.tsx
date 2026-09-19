import type { ReactNode } from 'react'

/**
 * O cabeçalho que só existe no papel.
 *
 * Um documento impresso é cobrado semanas depois, longe da tela que o gerou.
 * Sem a data de referência ninguém sabe de que foto ele fala — e a referência é
 * a última venda da empresa, não o dia da impressão: um sync parado não pode
 * envelhecer um documento assinado.
 *
 * Na tela isto não aparece, porque a tela já diz tudo isso no próprio contexto.
 */
export function PrintHeader({
  title, company, caption, referenceDate, provenance,
}: {
  title: string
  company?: string
  caption: string
  referenceDate?: string | null
  provenance?: ReactNode
}) {
  return (
    <div className="print-only mb-5 border-b pb-4">
      <div className="flex items-baseline justify-between gap-4">
        <h2 className="text-xl font-semibold">{title}</h2>
        <span className="text-sm text-muted-foreground">{company ?? ''}</span>
      </div>
      <p className="mt-1 text-sm text-muted-foreground">{caption}</p>
      <p className="mt-2 text-xs text-muted-foreground">
        {/* Meio-dia porque `date` puro vira UTC e retrocede um dia em São Paulo. */}
        Referência{' '}
        {referenceDate
          ? new Date(`${referenceDate}T12:00:00`).toLocaleDateString('pt-BR')
          : '—'}
        {provenance ? <> · {provenance}</> : null}
        {' · '}gerado em {new Date().toLocaleDateString('pt-BR')} pelo BoraRepô
      </p>
    </div>
  )
}
