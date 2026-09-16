import type { ReactNode } from 'react'
import { Info } from 'lucide-react'
import { GLOSSARY } from '@/lib/glossary'
import type { GlossaryKey } from '@/lib/glossary'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover'

/**
 * O "i" das colunas técnicas.
 *
 * É um `<button>`, e não um `<span>`, porque tooltip pendurado em elemento não
 * focável só existe para quem usa mouse — quem navega por teclado nunca
 * descobre o que é "Emáx".
 */
export function InfoHint({ term }: { term: GlossaryKey }) {
  const entry = GLOSSARY[term]
  const formula = 'formula' in entry ? entry.formula : undefined

  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <button
          type="button"
          aria-label={`O que é ${entry.term}`}
          className="inline-flex shrink-0 items-center rounded-xs text-mono-500 transition-colors hover:text-mono-1150 focus-visible:text-mono-1150 focus-visible:outline-none focus-visible:shadow-focus"
        >
          <Info className="h-3.5 w-3.5" />
        </button>
      </TooltipTrigger>
      <TooltipContent side="top" align="center" className="max-w-[17rem] whitespace-normal">
        <p className="font-semibold">{entry.term}</p>
        <p className="mt-1 font-normal leading-snug text-white/85">{entry.short}</p>
        {formula && (
          <p className="mt-2 border-t border-white/20 pt-1.5 font-data text-[11px] text-white/85">
            {formula}
          </p>
        )}
      </TooltipContent>
    </Tooltip>
  )
}

/**
 * Rótulo de cabeçalho com o "i" colado. `inline-flex` para que a coluna
 * alinhada à direita continue alinhada à direita — um bloco quebraria isso.
 */
export function ColLabel({ term, children }: { term: GlossaryKey; children: React.ReactNode }) {
  return (
    <span className="inline-flex items-center gap-1 align-middle">
      {children}
      <InfoHint term={term} />
    </span>
  )
}

/**
 * A nota de método de um cartão, guardada atrás do mesmo "i".
 *
 * Mora aqui junto do `InfoHint` para que a tela tenha UM "i" só, com um só
 * comportamento — dois ícones iguais que abrem coisas diferentes ensinam o
 * usuário a não clicar em nenhum.
 *
 * A diferença é o tamanho do que se diz: o `InfoHint` define um termo numa
 * frase, e cabe num tooltip de passar o mouse. Aqui são dois ou três parágrafos
 * de ressalva — texto que se lê UMA vez e que, permanente no rodapé de cada
 * cartão, vira parede e afoga os números que explica.
 *
 * O critério de recorte: o que MUDA com o dado (quanto ficou fora, se a série
 * está censurada) fica visível na tela; o método, que é sempre o mesmo, vem
 * para cá.
 */
export function ChartNote({ children, label = 'Como este número é calculado' }: {
  children: ReactNode
  label?: string
}) {
  return (
    <Popover>
      <PopoverTrigger asChild>
        <button
          type="button"
          aria-label={label}
          className="-m-1 shrink-0 rounded-xs p-1 text-mono-500 transition-colors hover:text-mono-1150 focus-visible:text-mono-1150 focus-visible:outline-none focus-visible:shadow-focus"
        >
          <Info className="h-3.5 w-3.5" />
        </button>
      </PopoverTrigger>
      <PopoverContent
        align="end"
        className="w-[min(100vw-2rem,340px)] space-y-2 p-3.5 text-xs leading-relaxed text-muted-foreground shadow-dropdown"
      >
        {children}
      </PopoverContent>
    </Popover>
  )
}

/** Título de cartão com a nota à direita, que é onde o olho vai procurá-la. */
export function CardTitleRow({ children, note, noteLabel }: {
  children: ReactNode
  note: ReactNode
  noteLabel?: string
}) {
  return (
    <div className="flex items-start justify-between gap-3">
      <div className="min-w-0 space-y-1.5">{children}</div>
      <ChartNote label={noteLabel}>{note}</ChartNote>
    </div>
  )
}
