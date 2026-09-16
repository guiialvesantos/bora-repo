import * as React from 'react'
import * as TabsPrimitive from '@radix-ui/react-tabs'
import { cn } from '@/lib/utils'

const Tabs = TabsPrimitive.Root

const TabsList = React.forwardRef<
  React.ElementRef<typeof TabsPrimitive.List>,
  React.ComponentPropsWithoutRef<typeof TabsPrimitive.List>
>(({ className, ...props }, ref) => (
  <TabsPrimitive.List
    ref={ref}
    className={cn(
      // Segmentado do Infinify: trilho PÍLULA em mono-200, botão ativo pílula
      // branca por dentro. Pílula dentro de pílula, não retângulo dentro de
      // retângulo — abas são controle, e controle é pílula no sistema.
      //
      // O ativo se marca por SUPERFÍCIE (branco + fio de sombra), não por cor
      // de marca: um trilho com um segmento verde dentro compete com o botão
      // primário da mesma tela, e aí a página tem dois "isto aqui".
      'inline-flex h-control items-center justify-center rounded-full bg-mono-200 p-1 text-mono-600',
      className,
    )}
    {...props}
  />
))
TabsList.displayName = TabsPrimitive.List.displayName

const TabsTrigger = React.forwardRef<
  React.ElementRef<typeof TabsPrimitive.Trigger>,
  React.ComponentPropsWithoutRef<typeof TabsPrimitive.Trigger>
>(({ className, ...props }, ref) => (
  <TabsPrimitive.Trigger
    ref={ref}
    className={cn(
      'inline-flex h-full items-center justify-center whitespace-nowrap rounded-full px-4 text-sm font-medium transition-ui hover:text-mono-1100 focus-visible:outline-none focus-visible:shadow-focus disabled:pointer-events-none disabled:text-mono-400 data-[state=active]:bg-surface data-[state=active]:font-semibold data-[state=active]:text-mono-1150 data-[state=active]:shadow-xs',
      className,
    )}
    {...props}
  />
))
TabsTrigger.displayName = TabsPrimitive.Trigger.displayName

const TabsContent = React.forwardRef<
  React.ElementRef<typeof TabsPrimitive.Content>,
  React.ComponentPropsWithoutRef<typeof TabsPrimitive.Content>
>(({ className, ...props }, ref) => (
  <TabsPrimitive.Content
    ref={ref}
    className={cn('mt-4 focus-visible:outline-none', className)}
    {...props}
  />
))
TabsContent.displayName = TabsPrimitive.Content.displayName

export { Tabs, TabsList, TabsTrigger, TabsContent }
