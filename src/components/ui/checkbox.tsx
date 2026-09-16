import * as React from 'react'
import * as CheckboxPrimitive from '@radix-ui/react-checkbox'
import { Check } from 'lucide-react'
import { cn } from '@/lib/utils'

const Checkbox = React.forwardRef<
  React.ElementRef<typeof CheckboxPrimitive.Root>,
  React.ComponentPropsWithoutRef<typeof CheckboxPrimitive.Root>
>(({ className, ...props }, ref) => (
  <CheckboxPrimitive.Root
    ref={ref}
    className={cn(
      // Desmarcado é fio de cabelo cinza; marcado é o 600 cheio com tique
      // branco — o mesmo par âncora do botão, para que "ligado" seja sempre a
      // mesma cor em toda a tela. O halo lima do foco saiu junto com o resto:
      // foco é anel neutro escuro, e desabilitado é troca de cor.
      'peer h-4 w-4 shrink-0 rounded-xs border border-border-strong transition-ui focus-visible:outline-none focus-visible:shadow-focus disabled:cursor-not-allowed disabled:border-mono-300 disabled:bg-mono-100 data-[state=checked]:border-brand-600 data-[state=checked]:bg-brand-600 data-[state=checked]:text-white',
      className,
    )}
    {...props}
  >
    <CheckboxPrimitive.Indicator className={cn('flex items-center justify-center text-current')}>
      <Check className="h-3.5 w-3.5" />
    </CheckboxPrimitive.Indicator>
  </CheckboxPrimitive.Root>
))
Checkbox.displayName = CheckboxPrimitive.Root.displayName

export { Checkbox }
