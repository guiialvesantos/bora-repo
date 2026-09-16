-- backtest-demand-rolling.sql — rolling origin × múltiplos horizontes.
-- Evolução do backtest-demand.sql: cortes a cada 4 semanas e horizontes de
-- 4/8/12/16/24 semanas (24 ≈ proteção LT+ciclo da Triana). SÓ LEITURA.
--
-- Elegibilidade por par (corte, horizonte): o realizado precisa caber antes
-- do fim da base, e o D180 precisa caber depois do início dela — senão o
-- modelo enxergaria janela truncada e a comparação seria injusta.
--
-- Métricas: wMAPE = Σ|prev−real| / Σreal; viés = Σ(prev−real) / Σreal
-- (positivo = superestima → capital parado; negativo = subestima → ruptura).

with bounds as (
  select min(sold_on) as first_sale, max(sold_on) as last_sale
  from public.sales_order_items
  where company_id = '356f1b17-2b72-45ba-a46a-ed50687d3211' and not shadow
),
grid as (
  select c.cutoff::date as cutoff, h.weeks as horizon
  from generate_series(date '2026-02-08', date '2026-08-16', interval '28 days') c(cutoff)
  cross join (values (4), (8), (12), (16), (24)) h(weeks)
  cross join bounds b
  where c.cutoff::date + h.weeks * 7 <= b.last_sale
    and c.cutoff::date - 182 >= b.first_sale
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
    g.cutoff, g.horizon, it.sku_norm, it.abc_class,
    min(s.sold_on) filter (where s.sold_on <= g.cutoff) as first_sale,
    coalesce(sum(s.qty) filter (where s.sold_on <= g.cutoff), 0) as total_before,
    coalesce(sum(s.qty) filter (where s.sold_on >  g.cutoff - 28  and s.sold_on <= g.cutoff), 0) / 4.0  as d28,
    coalesce(sum(s.qty) filter (where s.sold_on >  g.cutoff - 91  and s.sold_on <= g.cutoff), 0) / 13.0 as d90,
    coalesce(sum(s.qty) filter (where s.sold_on >  g.cutoff - 182 and s.sold_on <= g.cutoff), 0) / 26.0 as d180,
    coalesce(sum(s.qty) filter (where s.sold_on >  g.cutoff and s.sold_on <= g.cutoff + g.horizon * 7), 0)
      / g.horizon::numeric as actual
  from grid g
  cross join items it
  left join sales s on s.sku_norm = it.sku_norm
  group by 1, 2, 3, 4
),
models as (
  select p.*,
    case when p.d90 > 0 then least(greatest(p.d28 / p.d90, 0.75), 1.25) else 1 end as trend_f
  from per p
  where p.first_sale is not null
),
long_form as (
  select m.horizon, m.abc_class, m.actual, x.model, x.pred - m.actual as err
  from models m
  cross join lateral (values
    ('M0_legado',   (m.total_before / greatest((m.cutoff - m.first_sale)::numeric / 7, 4) + m.d28) / 2),
    ('M1_so28',     m.d28),
    ('M2_503020',   0.5 * m.d28 + 0.3 * m.d90 + 0.2 * m.d180),
    ('M3_503020_t', (0.5 * m.d28 + 0.3 * m.d90 + 0.2 * m.d180) * m.trend_f),
    ('M4_so90',     m.d90),
    ('M5_7090_30180', 0.7 * m.d90 + 0.3 * m.d180)
  ) as x(model, pred)
)
select
  horizon                                            as horizonte_sem,
  model                                              as modelo,
  count(*)                                           as n,
  round(sum(abs(err)) / nullif(sum(actual), 0), 3)   as wmape,
  round(sum(err) / nullif(sum(actual), 0), 3)        as vies,
  round((sum(abs(err)) filter (where abc_class = 'A'))
    / nullif(sum(actual) filter (where abc_class = 'A'), 0), 3) as wmape_a,
  round((sum(err) filter (where abc_class = 'A'))
    / nullif(sum(actual) filter (where abc_class = 'A'), 0), 3) as vies_a
from long_form
group by 1, 2
order by 1, wmape;
