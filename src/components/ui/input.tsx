import * as React from 'react'
import { cn } from '@/lib/utils'

const Input = React.forwardRef<HTMLInputElement, React.InputHTMLAttributes<HTMLInputElement>>(
  ({ className, type, ...props }, ref) => {
    return (
      <input
        type={type}
        className={cn(
          // Campo é RETÂNGULO MACIO (raio 8), não pílula — o corte duro entre
          // as duas formas é a assinatura do Infinify: controle que se aperta é
          // pílula, recipiente que recebe texto é retângulo.
          //
          // Altura vem de `--size-default`, a mesma do botão, que é o que faz
          // campo e botão de um filtro alinharem sem ninguém acertar na mão.
          //
          // No foco: a borda vira tinta neutra escura e um anel de 4px em
          // mono-200 aparece por fora. Neutro, não da marca — anel verde num
          // campo de formulário compete com o botão verde ao lado por atenção
          // e nenhum dos dois ganha.
          'flex h-control w-full rounded-sm border border-border bg-surface px-3 text-base transition-ui file:border-0 file:bg-transparent file:text-sm file:font-medium placeholder:text-mono-500 hover:border-border-strong focus-visible:border-mono-1150 focus-visible:shadow-input-active focus-visible:outline-none disabled:cursor-not-allowed disabled:border-mono-200 disabled:bg-mono-100 disabled:text-mono-400',
          className,
        )}
        ref={ref}
        {...props}
      />
    )
  },
)
Input.displayName = 'Input'

export { Input }
