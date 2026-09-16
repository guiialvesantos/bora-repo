import * as React from 'react'
import { cva } from 'class-variance-authority'
import type { VariantProps } from 'class-variance-authority'
import { cn } from '@/lib/utils'

/**
 * Etiqueta: pílula, sempre. Junto com botão e chip de filtro, é a metade
 * "controle" do corte de forma do Infinify — a outra metade (card, painel,
 * campo, menu) é retângulo macio.
 *
 * Fora do `default`, toda variante é TONAL: fundo no passo 100 do ramp, texto
 * no 800 do mesmo ramp. É o par que o sistema usa para estado calmo, e ele tem
 * uma propriedade que o preenchido não tem — dez etiquetas tonais numa tabela
 * ainda deixam a tabela legível, enquanto dez etiquetas preenchidas viram um
 * mosaico onde o olho não acha o número.
 */
export const badgeVariants = cva(
  'inline-flex items-center gap-1 rounded-full border px-2.5 py-0.5 text-xs font-medium transition-colors focus:outline-none',
  {
    variants: {
      variant: {
        default: 'border-transparent bg-brand-600 text-white',
        secondary: 'border-transparent bg-mono-200 text-mono-900',
        destructive: 'border-transparent bg-error-100 text-error-800',
        success: 'border-transparent bg-success-100 text-success-800',
        warning: 'border-transparent bg-warning-100 text-warning-800',
        outline: 'border-border text-foreground',
      },
    },
    defaultVariants: {
      variant: 'default',
    },
  },
)

export interface BadgeProps
  extends React.HTMLAttributes<HTMLDivElement>,
    VariantProps<typeof badgeVariants> {}

function Badge({ className, variant, ...props }: BadgeProps) {
  return <div className={cn(badgeVariants({ variant }), className)} {...props} />
}

export { Badge }
