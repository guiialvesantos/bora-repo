-- 0020 — tags, categoria e marca do produto (cadastro do Tiny)
--
-- A All Out governa o portfólio por tags no Tiny: `core` (reposição
-- contínua), `drop` (lançar e acabar — em avaliação), `exit` (saindo do
-- portfólio). A categoria ("Bermuda", "Shorts com bermuda"…) é a "solução"
-- que o produto oferece. Nada disso muda o motor por enquanto — primeiro os
-- dados aparecem na tela de Produtos; acoplar tag ↔ reposição é decisão
-- separada, com o usuário.
--
-- `tags` é text[] (não jsonb): a consulta típica é `= any(tags)` / overlap,
-- e o worker grava a lista já normalizada (lowercase, sem duplicata).

alter table public.products
  add column if not exists tags text[] not null default '{}',
  add column if not exists category text,
  add column if not exists brand text;
