import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { BrowserRouter, Navigate, Outlet, Route, Routes, useParams } from 'react-router-dom'
import { Toaster } from '@/components/ui/sonner'
import { TooltipProvider } from '@/components/ui/tooltip'
import { AuthProvider, useAuth } from '@/contexts/AuthContext'
import { CompanyProvider, useCompany } from '@/contexts/CompanyContext'
import { AppShell } from '@/components/layout/AppShell'
import Auth from '@/pages/Auth'
import Dashboard from '@/pages/Dashboard'
import DataHealth from '@/pages/DataHealth'
import PurchaseOrder from '@/pages/PurchaseOrder'
import AbcCurve from '@/pages/AbcCurve'
import Products from '@/pages/Products'
import ProductAnalysis from '@/pages/ProductAnalysis'
import Analysis from '@/pages/Analysis'
import StalledProducts from '@/pages/StalledProducts'
import Team from '@/pages/Team'
import Invite from '@/pages/Invite'
import Import from '@/pages/Import'
import Settings from '@/pages/Settings'
import Documentation from '@/pages/Documentation'
import Integrations from '@/pages/Integrations'

const queryClient = new QueryClient({
  defaultOptions: {
    queries: { refetchOnWindowFocus: false, retry: 1, staleTime: 30_000 },
  },
})

function FullScreenMessage({ children }: { children: React.ReactNode }) {
  return (
    <div className="flex min-h-screen items-center justify-center p-8 text-center text-sm text-muted-foreground">
      {children}
    </div>
  )
}

function LegacyProductRedirect() {
  const { productId } = useParams()
  return <Navigate to={`/analise/produto/${productId}`} replace />
}

function ProtectedLayout() {
  const { session, loading: authLoading } = useAuth()
  const { loading: companyLoading, needsCompany } = useCompany()

  if (authLoading) return <FullScreenMessage>Carregando…</FullScreenMessage>
  if (!session) return <Navigate to="/entrar" replace />
  if (companyLoading) return <FullScreenMessage>Carregando empresa…</FullScreenMessage>
  if (needsCompany) {
    return (
      <FullScreenMessage>
        Sua conta ainda não está vinculada a nenhuma empresa. Peça um convite ao administrador.
      </FullScreenMessage>
    )
  }

  return (
    <AppShell>
      <Outlet />
    </AppShell>
  )
}

export default function App() {
  return (
    <QueryClientProvider client={queryClient}>
      <BrowserRouter>
        <AuthProvider>
          <CompanyProvider>
            {/* Um provider só para o app inteiro: com um por tooltip, o atraso
                de abertura não é compartilhado e passar o mouse pela linha de
                cabeçalho acende cada "i" com meio segundo de espera. */}
            <TooltipProvider delayDuration={150} skipDelayDuration={300}>
              <Routes>
                <Route path="/entrar" element={<Auth />} />
                {/* Fora do layout protegido de propósito: quem chega por um
                    convite normalmente ainda não é membro de empresa nenhuma,
                    e o ProtectedLayout o mandaria para a tela de "peça um
                    convite ao administrador" — segurando na porta justamente
                    quem está com a chave na mão. */}
                <Route path="/convite/:token" element={<Invite />} />
                <Route element={<ProtectedLayout />}>
                  <Route path="/" element={<Navigate to="/painel" replace />} />
                  <Route path="/painel" element={<Dashboard />} />
                  <Route path="/saude-dos-dados" element={<DataHealth />} />
                  <Route path="/pedido" element={<PurchaseOrder />} />
                  <Route path="/curva-abc" element={<AbcCurve />} />
                  <Route path="/produtos" element={<Products />} />
                  {/* A ficha de produto mudou de casa para dentro de /analise.
                      Este redirecionamento existe porque o link antigo já foi
                      compartilhado e salvo — quebrar favorito não é upgrade. */}
                  <Route path="/produtos/:productId" element={<LegacyProductRedirect />} />
                  <Route path="/analise" element={<Analysis />}>
                    <Route index element={<Navigate to="/analise/encalhados" replace />} />
                    <Route path="encalhados" element={<StalledProducts />} />
                    <Route path="produto" element={<ProductAnalysis />} />
                    <Route path="produto/:productId" element={<ProductAnalysis />} />
                  </Route>
                  <Route path="/equipe" element={<Team />} />
                  <Route path="/importar" element={<Import />} />
                  <Route path="/integracoes" element={<Integrations />} />
                  <Route path="/configuracoes" element={<Settings />} />
                  <Route path="/documentacao" element={<Documentation />} />
                  <Route path="/documentacao/:slug" element={<Documentation />} />
                </Route>
                <Route path="*" element={<Navigate to="/painel" replace />} />
              </Routes>
            </TooltipProvider>
            <Toaster />
          </CompanyProvider>
        </AuthProvider>
      </BrowserRouter>
    </QueryClientProvider>
  )
}
