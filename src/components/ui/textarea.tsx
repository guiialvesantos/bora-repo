import * as React from 'react'
import { cn } from '@/lib/utils'

const Textarea = React.forwardRef<
  HTMLTextAreaElement,
  React.TextareaHTMLAttributes<HTMLTextAreaElement>
>(({ className, ...props }, ref) => {
  return (
    <textarea
      className={cn(
        // Mesma anatomia do Input — só que sem altura fixa, porque cresce. Sem
        // `shadow-sm`: campo não é superfície elevada, é recorte na página.
        'flex min-h-[80px] w-full rounded-sm border border-border bg-surface px-3 py-2 text-base transition-ui placeholder:text-mono-500 hover:border-border-strong focus-visible:border-mono-1150 focus-visible:shadow-input-active focus-visible:outline-none disabled:cursor-not-allowed disabled:border-mono-200 disabled:bg-mono-100 disabled:text-mono-400',
        className,
      )}
      ref={ref}
      {...props}
    />
  )
})
Textarea.displayName = 'Textarea'

export { Textarea }
