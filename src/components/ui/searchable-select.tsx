import { useMemo, useState, type ReactNode } from 'react'
import { Check, ChevronsUpDown } from 'lucide-react'
import { Button } from '@/components/ui/button'
import {
  Command,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
} from '@/components/ui/command'
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover'
import { cn } from '@/lib/utils'

export interface SearchableOption {
  value: string
  label: string
  keywords?: string
  disabled?: boolean
  node?: ReactNode
}

interface Props {
  value: string
  onValueChange: (value: string) => void
  options: SearchableOption[]
  placeholder?: string
  searchPlaceholder?: string
  emptyText?: string
  disabled?: boolean
  triggerClassName?: string
  contentClassName?: string
  /** Conteúdo customizado do trigger (avatar, chip, etc.). */
  trigger?: ReactNode
  align?: 'start' | 'center' | 'end'
  /** Aria label do botão. */
  'aria-label'?: string
}

export function SearchableSelect({
  value,
  onValueChange,
  options,
  placeholder = 'Selecionar…',
  searchPlaceholder = 'Digite para buscar…',
  emptyText = 'Nenhum resultado',
  disabled,
  triggerClassName,
  contentClassName,
  trigger,
  align = 'start',
  'aria-label': ariaLabel,
}: Props) {
  const [open, setOpen] = useState(false)

  const selected = useMemo(
    () => options.find((o) => o.value === value),
    [options, value],
  )

  return (
    <Popover open={open} onOpenChange={setOpen} modal={false}>
      <PopoverTrigger asChild>
        <Button
          type="button"
          variant="outline"
          role="combobox"
          aria-expanded={open}
          aria-label={ariaLabel}
          disabled={disabled}
          className={cn(
            // Gatilho de busca é caixa, não pílula: ele abre um campo de texto,
            // então segue a forma do Input. Borda e fundo sólidos — o `/80` e o
            // `/55` de antes davam cinzas diferentes conforme a superfície.
            'h-control-sm justify-between gap-1.5 rounded-sm border-border bg-surface px-2.5 text-[13px] font-medium text-foreground shadow-none hover:border-border-strong hover:bg-mono-100 data-[state=open]:border-brand-600 data-[state=open]:bg-brand-100',
            !selected && 'text-mono-500',
            triggerClassName,
          )}
        >
          <span className="min-w-0 flex-1 truncate text-left">
            {trigger ?? selected?.node ?? selected?.label ?? placeholder}
          </span>
          <ChevronsUpDown className="h-3.5 w-3.5 shrink-0 text-mono-500" />
        </Button>
      </PopoverTrigger>
      <PopoverContent
        align={align}
        className={cn('z-[80] w-[min(100vw-2rem,280px)] p-0 shadow-dropdown', contentClassName)}
        onOpenAutoFocus={(e) => {
          e.preventDefault()
          const input = (e.currentTarget as HTMLElement).querySelector('input')
          input?.focus()
        }}
      >
        <Command shouldFilter>
          <CommandInput placeholder={searchPlaceholder} />
          <CommandList>
            <CommandEmpty>{emptyText}</CommandEmpty>
            <CommandGroup>
              {options.map((opt) => (
                <CommandItem
                  key={opt.value}
                  value={`${opt.label} ${opt.keywords ?? ''} ${opt.value}`}
                  disabled={opt.disabled}
                  onSelect={() => {
                    onValueChange(opt.value)
                    setOpen(false)
                  }}
                >
                  <Check
                    className={cn(
                      'h-3.5 w-3.5 shrink-0',
                      value === opt.value ? 'text-brand-600' : 'opacity-0',
                    )}
                  />
                  <span className="min-w-0 flex-1 truncate">
                    {opt.node ?? opt.label}
                  </span>
                </CommandItem>
              ))}
            </CommandGroup>
          </CommandList>
        </Command>
      </PopoverContent>
    </Popover>
  )
}
