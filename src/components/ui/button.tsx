import * as React from 'react'
import { Slot } from '@radix-ui/react-slot'
import { cva } from 'class-variance-authority'
import type { VariantProps } from 'class-variance-authority'
import { cn } from '@/lib/utils'

/**
 * Botão no modelo do Infinify: pílula, cinco estados, e a transição de estado
 * feita SÓ por substituição de cor.
 *
 * As três regras que vieram do sistema e que é fácil desfazer sem perceber:
 *
 * 1. **Hover e active descem no ramp, nunca mexem em opacidade nem em escala.**
 *    O `active:scale-[.97]` que existia aqui saiu por isso — o Infinify não
 *    tem encolhimento, mola nem coreografia de entrada em lugar nenhum. Filled
 *    600 → 700 no hover → 900 no pressionado. Tonal 200 → 300 → 400.
 * 2. **Disabled é troca de cor, não `opacity-50`.** Um botão a 50% de opacidade
 *    deixa o fundo atravessar e muda de aparência conforme onde está pousado;
 *    o 300 do ramp é sempre o mesmo cinza-verde, em cima de qualquer coisa.
 * 3. **Foco é anel neutro escuro**, não halo da marca — `shadow-focus` é 2px de
 *    respiro na cor do fundo e 2px de tinta. Halo verde num botão verde não
 *    mostra foco nenhum, que era o defeito do anel lima.
 *
 * Alturas vêm de `--size-*`, compartilhadas com Input e Select. É o que faz um
 * botão de filtro alinhar com o campo ao lado sem ninguém ajustar na mão.
 */
export const buttonVariants = cva(
  'inline-flex items-center justify-center gap-2 whitespace-nowrap rounded-full font-semibold transition-ui focus-visible:outline-none focus-visible:shadow-focus disabled:pointer-events-none [&_svg]:pointer-events-none [&_svg]:size-4 [&_svg]:shrink-0',
  {
    variants: {
      variant: {
        // Filled: o passo 600 com texto branco. O par âncora do sistema.
        default:
          'bg-brand-600 text-white hover:bg-brand-700 active:bg-brand-900 disabled:bg-brand-300 disabled:text-brand-400',
        // Filled mono — a ação escura e neutra.
        dark: 'bg-mono-700 text-white hover:bg-mono-900 active:bg-mono-1100 disabled:bg-mono-300 disabled:text-mono-100',
        destructive:
          'bg-error-600 text-white hover:bg-error-700 active:bg-error-900 disabled:bg-error-300',
        // Outline: fio na cor base, texto na secundária, lavagem tonal no hover.
        outline:
          'border border-brand-600 bg-transparent text-brand-600 hover:bg-brand-100 active:bg-brand-200 disabled:border-mono-200 disabled:text-mono-400',
        // Tonal mono — o "Cancelar" ao lado de uma ação primária.
        secondary:
          'bg-mono-200 text-foreground hover:bg-mono-300 active:bg-mono-400 disabled:bg-mono-100 disabled:text-mono-400',
        // Bare: transparente parado, lavagem tonal no hover.
        ghost:
          'text-mono-700 hover:bg-mono-200 hover:text-mono-1100 active:bg-mono-300 disabled:text-mono-400',
        link: 'text-brand-600 underline-offset-4 hover:text-brand-900 hover:underline disabled:text-mono-400',
      },
      size: {
        lg: 'h-control-lg px-5 text-base',
        default: 'h-control px-4 text-base',
        sm: 'h-control-sm px-3.5 text-sm',
        xs: 'h-control-xs px-3 text-[13px]',
        icon: 'h-control-sm w-control-sm p-0',
        'icon-lg': 'h-control w-control p-0',
      },
    },
    defaultVariants: {
      variant: 'default',
      size: 'default',
    },
  },
)

export interface ButtonProps
  extends React.ButtonHTMLAttributes<HTMLButtonElement>,
    VariantProps<typeof buttonVariants> {
  asChild?: boolean
}

const Button = React.forwardRef<HTMLButtonElement, ButtonProps>(
  ({ className, variant, size, asChild = false, ...props }, ref) => {
    const Comp = asChild ? Slot : 'button'
    return (
      <Comp className={cn(buttonVariants({ variant, size, className }))} ref={ref} {...props} />
    )
  },
)
Button.displayName = 'Button'

export { Button }
