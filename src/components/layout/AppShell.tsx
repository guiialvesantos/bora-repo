import { useEffect, useState } from 'react'
import type { ReactNode } from 'react'
import { NavLink, useLocation } from 'react-router-dom'
import {
  Activity,
  BarChart3,
  BookOpen,
  Boxes,
  ChevronsLeft,
  ChevronsRight,
  FileText,
  LogOut,
  Package,
  Plug,
  Plus,
  Settings as SettingsIcon,
  ShoppingCart,
  TrendingDown,
  Upload,
  Users,
} from 'lucide-react'
import { cn } from '@/lib/utils'
import { useAuth } from '@/contexts/AuthContext'
import { useCompany } from '@/contexts/CompanyContext'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import { DataHealthBanner } from '@/components/health/DataHealthBanner'
import { NewCompanyDialog } from '@/components/layout/NewCompanyDialog'

/** Sentinela do item "Nova empresa" no seletor — nunca é um id real. */
const NEW_COMPANY = '__new__'

/** A escolha de barra aberta ou fechada acompanha a pessoa, não a sessão. */
const COLLAPSE_KEY = 'reporia:nav-collapsed'

const NAV = [
  { to: '/painel', label: 'Painel', icon: Boxes },
  { to: '/pedido', label: 'Pedido de compra', icon: ShoppingCart },
  { to: '/curva-abc', label: 'Curva ABC', icon: BarChart3 },
  { to: '/produtos', label: 'Produtos', icon: Package },
  { to: '/analise', label: 'Análise', icon: TrendingDown },
  { to: '/relatorios', label: 'Relatórios', icon: FileText },
  { to: '/saude-dos-dados', label: 'Saúde dos dados', icon: Activity },
  { to: '/importar', label: 'Importar', icon: Upload },
  { to: '/integracoes', label: 'Integrações', icon: Plug },
  { to: '/equipe', label: 'Equipe', icon: Users },
  { to: '/configuracoes', label: 'Configurações', icon: SettingsIcon },
  { to: '/documentacao', label: 'Documentação', icon: BookOpen },
]

export function AppShell({ children }: { children: ReactNode }) {
  const { signOut, user } = useAuth()
  const { memberships, companyId, selectCompany } = useCompany()
  const [newCompanyOpen, setNewCompanyOpen] = useState(false)
  const { pathname } = useLocation()

  const [collapsed, setCollapsed] = useState(
    () => localStorage.getItem(COLLAPSE_KEY) === '1',
  )
  // A gravação fica FORA do updater. Ela estava dentro, e updater de `setState`
  // tem que ser puro: o React o invoca duas vezes em desenvolvimento e pode
  // reexecutá-lo ao descartar um render concorrente. Com o `setItem` lá dentro,
  // o disco recebia uma escrita por invocação e a preferência guardada
  // divergia do que estava na tela — a barra reabria fechada sem ninguém ter
  // fechado. Como efeito, a escrita segue o valor final e é idempotente.
  useEffect(() => {
    localStorage.setItem(COLLAPSE_KEY, collapsed ? '1' : '0')
  }, [collapsed])

  const company = memberships.find((m) => m.company.id === companyId)?.company

  return (
    // O `.shell` do kit de dashboard do Infinify: fundo cinza, 16 de respiro em
    // volta e 16 de vão entre as colunas. O cinza é MOLDURA, não superfície —
    // tudo que tem conteúdo mora numa peça branca sobre ele.
    <div className="flex min-h-screen gap-4 bg-background p-4">
      {/* `SidebarNav` do Infinify, com os dois estados que ele define: aberta
          em 248 e fechada no trilho de 72. Fechada, o componente não vira
          outra coisa — são as MESMAS linhas viradas quadrado de 44, o rótulo
          sai e o `title` assume. A largura é o que anima (280ms), e por isso
          o `overflow-hidden`: sem ele o texto vaza durante a transição. */}
      <aside
        className={cn(
          // As medidas da barra estão em PÍXEL CRAVADO, não na escala `rem` do
          // Tailwind. O `html` deste projeto roda com `font-size: 14px`, então
          // `h-11` dá 38,5px e não os 44 que o Infinify especifica — toda a
          // barra sairia 12,5% menor que o desenho. Onde a fonte nomeia um
          // número absoluto (72 / 248 / 44 / 40 / 24 / 12), ele vai literal.
          //
          // `sticky` com altura de viewport porque a página rola muito: sem
          // isso a barra estica junto com o conteúdo e "Sair" e o gatilho de
          // recolher só aparecem no fim de cinco mil píxeis de rolagem.
          'sticky top-4 flex h-[calc(100vh-2rem)] shrink-0 flex-col overflow-hidden rounded-lg border border-border bg-surface p-[12px] shadow-card transition-[width] duration-slow ease-standard',
          collapsed ? 'w-[72px]' : 'w-[248px]',
        )}
      >
        {/* Ladrilho mono-100 com a marca dentro, como na fonte — o verde vem do
            ícone, não do fundo. Ladrilho verde cheio competiria com o item
            ativo logo abaixo, que é a única lavagem de marca da tela. */}
        <div
          className={cn(
            'flex items-center gap-3 px-1 pb-4 pt-1',
            collapsed && 'justify-center px-0',
          )}
        >
          {/* 44 fechada, 40 aberta — os dois números são da fonte (`Rail` usa
              44, `SidebarNav` usa 40). Fechada, o ladrilho tem que ocupar a
              mesma coluna de 44 dos itens, ou o topo da barra desalinha. */}
          <span
            className={cn(
              'flex shrink-0 items-center justify-center rounded-nav bg-mono-100',
              collapsed ? 'h-[44px] w-[44px]' : 'h-[40px] w-[40px]',
            )}
          >
            <Boxes className="h-[24px] w-[24px] text-brand-600" strokeWidth={1.75} />
          </span>
          {!collapsed && (
            <span className="whitespace-nowrap font-display text-lg font-semibold tracking-tight text-foreground">
              ReporIA
            </span>
          )}
        </div>

        {/* O seletor de empresa NÃO some quando fecha. Num sistema de duas
            marcas, todo número da tela depende dele: esconder qual está ativa
            é como esconder a unidade do valor. Fechado ele vira o quadrado de
            44 com a inicial, e o nome inteiro fica no `title`. */}
        <div className={cn('pb-3', collapsed && 'flex justify-center')}>
          <Select
            value={companyId ?? undefined}
            onValueChange={(v) => {
              if (v === NEW_COMPANY) setNewCompanyOpen(true)
              else selectCompany(v)
            }}
          >
            <SelectTrigger
              title={collapsed ? company?.name : undefined}
              className={cn(
                collapsed &&
                  'h-[44px] w-[44px] justify-center rounded-nav border-0 bg-mono-100 px-0 text-sm font-semibold text-mono-700 hover:bg-mono-200 [&>svg]:hidden',
              )}
            >
              {collapsed ? (
                (company?.name ?? '—').trim().charAt(0).toUpperCase()
              ) : (
                <SelectValue placeholder="Empresa" />
              )}
            </SelectTrigger>
            <SelectContent>
              {memberships.map((m) => (
                <SelectItem key={m.company.id} value={m.company.id}>
                  {m.company.name}
                </SelectItem>
              ))}
              <SelectItem value={NEW_COMPANY}>
                <span className="flex items-center gap-2">
                  <Plus className="h-3.5 w-3.5" /> Nova empresa
                </span>
              </SelectItem>
            </SelectContent>
          </Select>
        </div>

        {/* Linha de navegação: 44 de altura, raio 10, ícone de 24. Ativo é
            lavagem `brand-100` com rótulo em `#055120` e peso semibold;
            inativo é texto de corpo cheio com hover em `mono-100`.

            O tooltip sai à DIREITA, como no trilho da fonte: à esquerda ele
            cairia fora da janela, e em cima taparia o item vizinho. É o
            tooltip do sistema (mono-1150 com texto branco) e não o `title` do
            navegador — aquele leva um segundo para aparecer, não tem estilo e
            some sozinho.

            O estado ativo sai do `pathname` e NÃO do `className` como função
            do `NavLink`. O motivo é concreto: `TooltipTrigger asChild` clona o
            filho e passa um `className` string próprio, que ganha do da
            função — e a função vira texto dentro do atributo. O item some de
            estilo inteiro, sem erro nenhum no console. */}
        <nav className="flex flex-1 flex-col gap-[4px]">
          {NAV.map(({ to, label, icon: Icon }) => {
            const isActive = pathname === to || pathname.startsWith(`${to}/`)
            return (
              <Tooltip key={to}>
                <TooltipTrigger asChild>
                  <NavLink
                    to={to}
                    className={cn(
                      'flex h-[44px] shrink-0 items-center gap-[12px] rounded-nav text-sm transition-colors duration-fast',
                      collapsed ? 'w-[44px] justify-center px-0' : 'px-[12px]',
                      // Ativo CHAPADO, não em lavagem. O Infinify usa o tonal
                      // (brand-100 com texto brand-600), e sobre uma barra que
                      // já é branca aquilo ficava a um fio de distância do
                      // hover cinza — a barra inteira lia como cinza. Chapado,
                      // a página em que se está tem peso de bloco.
                      isActive
                        ? 'bg-brand-600 font-semibold text-white shadow-button'
                        : 'font-medium text-mono-700 hover:bg-brand-100 hover:text-brand-700',
                    )}
                  >
                    <Icon className="h-[24px] w-[24px] shrink-0" strokeWidth={1.75} />
                    {!collapsed && <span className="truncate">{label}</span>}
                  </NavLink>
                </TooltipTrigger>
                <TooltipContent side="right" sideOffset={8}>
                  {label}
                </TooltipContent>
              </Tooltip>
            )
          })}
        </nav>

        <div className="pt-3">
          {!collapsed && (
            <p className="truncate px-1 pb-1 text-xs text-muted-foreground">{user?.email}</p>
          )}
          <Tooltip>
            <TooltipTrigger asChild>
              <button
                type="button"
                onClick={signOut}
                className={cn(
                  'flex h-[44px] shrink-0 items-center gap-[12px] rounded-nav text-sm font-medium text-foreground transition-colors duration-fast hover:bg-mono-100 focus-visible:outline-none focus-visible:shadow-focus',
                  collapsed ? 'w-[44px] justify-center px-0' : 'w-full px-[12px]',
                )}
              >
                <LogOut className="h-[24px] w-[24px] shrink-0" strokeWidth={1.75} />
                {!collapsed && 'Sair'}
              </button>
            </TooltipTrigger>
            <TooltipContent side="right" sideOffset={8}>
              Sair
            </TooltipContent>
          </Tooltip>
        </div>

        {/* O gatilho: `chevrons-left` aberta, `chevrons-right` fechada, no pé
            da barra. É o mesmo par de ícones da fonte. */}
        <div className={cn('flex pt-3', collapsed ? 'justify-center' : 'justify-start')}>
          <Tooltip>
            <TooltipTrigger asChild>
              <button
                type="button"
                onClick={() => setCollapsed((c) => !c)}
                aria-label={collapsed ? 'Expandir navegação' : 'Recolher navegação'}
                className="inline-flex rounded-sm p-[6px] text-mono-600 transition-colors duration-fast hover:bg-mono-100 hover:text-foreground focus-visible:outline-none focus-visible:shadow-focus"
              >
                {collapsed ? (
                  <ChevronsRight className="h-[24px] w-[24px]" strokeWidth={1.75} />
                ) : (
                  <ChevronsLeft className="h-[24px] w-[24px]" strokeWidth={1.75} />
                )}
              </button>
            </TooltipTrigger>
            <TooltipContent side="right" sideOffset={8}>
              {collapsed ? 'Expandir navegação' : 'Recolher navegação'}
            </TooltipContent>
          </Tooltip>
        </div>
      </aside>

      {/* `.main`: coluna com 20 de vão entre as peças. O respiro externo já
          vem do `.shell`, então aqui não há padding — se houvesse, o conteúdo
          andaria para dentro e o vão de 16 entre barra e conteúdo dobraria. */}
      <main className="flex min-w-0 flex-1 flex-col gap-5">
        <DataHealthBanner />
        {children}
      </main>

      <NewCompanyDialog open={newCompanyOpen} onOpenChange={setNewCompanyOpen} />
    </div>
  )
}
