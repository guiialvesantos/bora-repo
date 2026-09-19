import { Link, Outlet, useLocation } from 'react-router-dom'

/**
 * Configurações: o que se mexe uma vez e depois se esquece.
 *
 * Os cinco itens daqui viviam soltos na barra lateral, do mesmo tamanho que
 * Painel e Pedido de compra. Só que a barra é a lista do que se faz TODO DIA, e
 * ninguém conecta uma integração ou convida a equipe toda semana — o resultado
 * era uma barra de doze linhas onde as seis que importam ficavam diluídas.
 *
 * Saúde dos dados é o caso mais claro: é uma tela que só interessa quando algo
 * quebrou, e para isso ela já tem porta própria — o `DataHealthBanner` aparece
 * em cima de TODA rota e some quando não há problema. Um item fixo no menu para
 * uma tela de exceção é ruído nos outros 29 dias do mês.
 *
 * AS URLS NÃO MUDARAM, e isso é de propósito. Agrupar aqui é mudança de
 * NAVEGAÇÃO, não de endereço: a Edge Function `tiny-oauth` devolve o usuário
 * para `/integracoes?tiny_v3=connected` com o caminho escrito no servidor, e o
 * `DataHealthBanner` aponta para `/saude-dos-dados`. Mover as rotas obrigaria a
 * redeploy da função e a redirecionamentos que preservassem a query string —
 * risco real, e o ganho seria só uma URL mais bonita. Em vez disso, o layout
 * entra por uma rota SEM path (ver `App.tsx`), que veste as telas de abas sem
 * tocar no endereço de nenhuma delas.
 */
const TABS = [
  { to: '/configuracoes', label: 'Parâmetros' },
  { to: '/integracoes', label: 'Integrações' },
  { to: '/depositos', label: 'Depósitos' },
  { to: '/importar', label: 'Importar' },
  { to: '/equipe', label: 'Equipe' },
  { to: '/saude-dos-dados', label: 'Saúde dos dados' },
]

export default function SettingsHub() {
  const { pathname } = useLocation()

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-page-title">Configurações</h1>
        <p className="text-sm text-muted-foreground">
          De onde vêm os dados, quem tem acesso e com que parâmetros o motor roda.
        </p>
      </div>

      {/* Mesma faixa de abas da tela de Análise. São seis e cabem numa linha;
          se um dia não couberem, o `flex-wrap` quebra em duas em vez de cortar
          a última no fio da borda. */}
      <div className="inline-flex flex-wrap gap-1 rounded-md bg-mono-200 p-1">
        {TABS.map((t) => {
          const active = pathname.startsWith(t.to)
          return (
            <Link
              key={t.to}
              to={t.to}
              className={
                'rounded-sm px-3 py-1.5 text-[13px] font-medium transition-colors '
                + (active
                  ? 'bg-white text-foreground shadow-sm'
                  : 'text-muted-foreground hover:text-foreground')
              }
            >
              {t.label}
            </Link>
          )
        })}
      </div>

      <Outlet />
    </div>
  )
}
