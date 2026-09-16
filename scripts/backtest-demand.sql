-- backtest-demand.sql — compara modelos de estimativa de demanda contra a
-- venda realizada. SÓ LEITURA: nada muda no motor nem nos parâmetros.
--
-- Método: congela a base em cada data de corte, calcula a taxa semanal que
-- cada modelo teria previsto naquele dia, e compara com a taxa semanal REAL
-- das 12 semanas seguintes (~lead time de 80 dias). Múltiplos cortes para a
-- conclusão não depender da sorte de uma janela específica.
--
-- Modelos:
--   legado    (weekly_all + D28)/2 — o blend 50/50 do motor atual, com o piso
--             de 4 semanas do weeks_in_catalog
--   w503020   0,50·D28 + 0,30·D90 + 0,20·D180 — janelas ponderadas (proposta V2)
--   so28      só D28 (reage rápido, mas ruidoso — o extremo oposto do legado)
--   so90      só D90 (meio-termo sem blend)
--
-- Universo: itens em coleção do último snapshot que já vendiam antes do corte.
-- Vieses conhecidos (aceitos, iguais para todos os modelos):
--   · in_collection/ABC vêm do snapshot atual (leve look-ahead na seleção);
--   · a venda realizada é censurada por ruptura — sem histórico de estoque
--     antes de 13/09/2026 (stockout_periods) não há como corrigir o passado.
--
-- Métricas: MAE (erro médio absoluto, peças/semana), viés (positivo = modelo
-- superestima), wMAPE (Σ|erro| / Σ real — dá mais peso a quem vende mais).

with cutoffs as (
  select d::date as cutoff
  from (values ('2026-03-29'), ('2026-04-26'), ('2026-05-24'), ('2026-06-21')) v(d)
),
snap as (
  select id from public.replenishment_snapshots
  where company_id = '356f1b17-2b72-45ba-a46a-ed50687d3211'
  order by created_at desc limit 1
),
items as (
  select distinct nullif(upper(btrim(i.sku)), '') as sku_norm, i.abc_class
  from public.replenishment_snapshot_items i
  join snap on i.snapshot_id = snap.id
  where i.in_collection and nullif(upper(btrim(i.sku)), '') is not null
),
sales as (
  select s.sku_norm, s.sold_on, s.qty
  from public.sales_order_items s
  where s.company_id = '356f1b17-2b72-45ba-a46a-ed50687d3211' and not s.shadow
),
per as (
  select
    c.cutoff, it.sku_norm, it.abc_class,
    min(s.sold_on) filter (where s.sold_on <= c.cutoff) as first_sale,
    coalesce(sum(s.qty) filter (where s.sold_on <= c.cutoff), 0) as total_before,
    coalesce(sum(s.qty) filter (where s.sold_on >  c.cutoff - 28  and s.sold_on <= c.cutoff), 0) / 4.0  as d28,
    coalesce(sum(s.qty) filter (where s.sold_on >  c.cutoff - 91  and s.sold_on <= c.cutoff), 0) / 13.0 as d90,
    coalesce(sum(s.qty) filter (where s.sold_on >  c.cutoff - 182 and s.sold_on <= c.cutoff), 0) / 26.0 as d180,
    coalesce(sum(s.qty) filter (where s.sold_on >  c.cutoff and s.sold_on <= c.cutoff + 84), 0) / 12.0  as actual
  from cutoffs c
  cross join items it
  left join sales s on s.sku_norm = it.sku_norm
  group by 1, 2, 3
),
models as (
  select
    p.cutoff, p.sku_norm, p.abc_class, p.actual,
    ( p.total_before / greatest((p.cutoff - p.first_sale)::numeric / 7, 4) + p.d28 ) / 2 as legado,
    0.5 * p.d28 + 0.3 * p.d90 + 0.2 * p.d180 as w503020,
    p.d28 as so28,
    p.d90 as so90
  from per p
  where p.first_sale is not null   -- só quem já vendia antes do corte
),
long_form as (
  select m.cutoff, m.sku_norm, m.abc_class, m.actual, x.model, x.pred - m.actual as err
  from models m
  cross join lateral (values
    ('legado',  m.legado),
    ('w503020', m.w503020),
    ('so28',    m.so28),
    ('so90',    m.so90)
  ) as x(model, pred)
)
select
  coalesce(cutoff::text, 'TODOS')    as corte,
  model                              as modelo,
  count(*)                           as skus,
  round(avg(abs(err)), 3)            as mae,
  round(avg(err), 3)                 as vies,
  round(sum(abs(err)) / nullif(sum(actual), 0), 3) as wmape
from long_form
group by grouping sets ((cutoff, model), (model))
order by corte, wmape;
