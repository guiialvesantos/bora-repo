# ReporIA — stock.linqer.com.br

Sistema de reposição de estoque multi-empresa. Substitui a planilha de compra
da Triana (semijoias): importa vendas, estoque e em-trânsito (Tiny/Olist v2 +
importação manual), calcula por SKU o estoque de segurança, o ponto de pedido
e o estoque máximo, e gera o pedido de compra.

**A regra da casa:** nada entra no motor porque parece sofisticado. Modelos
novos precisam vencer a referência fora da amostra (backtest) ou melhorar o
resultado econômico; correções de definição precisam provar por diff que a
regra antiga representava mal o fenômeno. Toda mudança de comportamento nasce
atrás de flag versionada, com snapshot antes e depois.

## Documentação

| Documento | O que explica |
|---|---|
| [`docs/motor.md`](docs/motor.md) | O cálculo de ponta a ponta, com fórmulas reais, exemplos numéricos e analogias — demanda `0,7×D90 + 0,3×D180`, σ ancorado na 1ª venda do SKU, ABC, ES/PP/EMax, e o ritual de evolução (flag → diff → publicação) |
| [`docs/xyz.md`](docs/xyz.md) | A camada XYZ de previsibilidade — CV com cortes calibrados na própria base, erro histórico do backtest por SKU, matriz ABC×XYZ e prioridade de atenção |
| [`docs/divergencias.md`](docs/divergencias.md) | Os cinco erros da planilha original, encontrados na auditoria célula a célula, e o harness de paridade que provou a migração |

## Stack

React 19 + Vite + TypeScript + Tailwind/shadcn, TanStack Query 5, Supabase
(Postgres é o motor — todo o cálculo é SQL em `supabase/migrations/`), deploy
em Cloudflare Workers.

## Comandos

```sh
npx tsc -p tsconfig.app.json --noEmit   # gate de tipos
npx vite build && npx wrangler deploy   # build + deploy
npm run parity                          # harness de paridade contra a planilha
node scripts/audit-grants.mjs           # falha se anon tiver EXECUTE em algo
```

## Convenções que salvam horas

- Tela nenhuma recalcula nada: as quatro telas leem o mesmo `snapshot_id`.
- `numeric` chega como **string** pelo PostgREST — converter na borda (`num()`).
- Leituras que podem passar de 1000 linhas usam `fetchAllRows()` — o PostgREST
  trunca em silêncio.
- Função SECURITY DEFINER: revogar EXECUTE de `public`, `anon` **e**
  `authenticated` antes de qualquer grant dirigido, e revalidar
  `has_company_role()` no corpo.
- Parâmetros do motor são append-only: nunca `UPDATE`, sempre
  `publish_replenishment_params()`.
