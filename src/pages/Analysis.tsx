import { Link, Outlet, useLocation } from 'react-router-dom'

/**
 * As duas perguntas que se faz depois que o Painel mostrou o número.
 *
 * "Encalhados" olha o catálogo inteiro e responde o que fazer com o que parou.
 * "Produto" olha uma peça só e responde por que ela está do jeito que está.
 * São o mesmo movimento em escalas diferentes — do agregado para a peça — e
 * por isso dividem uma casa em vez de duas entradas no menu.
 */

const TABS = [
  { to: '/analise/encalhados', label: 'Encalhados' },
  { to: '/analise/produto', label: 'Produto' },
]

export default function Analysis() {
  const { pathname } = useLocation()

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-page-title">Análise</h1>
        <p className="text-sm text-muted-foreground">
          O que parou de sair e o que aconteceu com cada peça.
        </p>
      </div>

      <div className="inline-flex gap-1 rounded-md bg-mono-200 p-1">
        {TABS.map((t) => {
          const active = pathname.startsWith(t.to)
          return (
            <Link
              key={t.to}
              to={t.to}
              className={
                'rounded-sm px-3 py-1.5 text-[13px] font-medium transition-colors ' +
                (active
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
