-- 0018_xyz.sql — camada XYZ de previsibilidade (leitura, fora do motor).
--
-- ABC diz o que importa (fatia do faturamento). XYZ diz o quanto dá para
-- confiar na previsão de cada item. Um SKU "AZ" — importante E errático — é
-- exatamente onde o modelo mais erra e onde o olho humano vale mais.
--
-- Duas fontes, nesta ordem:
--   1. CV = σ / demanda semanal ponderada (eixo principal). Os cortes NÃO são
--      os "0,5 / 1,0" genéricos da literatura: foram calibrados nos tercis da
--      própria base da Triana em 13/09/2026 (p33 ≈ 1,02 → 1,0; p66 ≈ 1,61 →
--      1,6). Semijoia tem demanda intermitente; corte genérico jogaria quase
--      tudo em Z e a classe perderia o poder de separar.
--   2. Erro histórico do forecast (contexto, nunca eixo). wMAPE por SKU medido
--      no backtest rolling do modelo vivo. Slow mover que vende 1/semana tem
--      wMAPE enorme por construção — por isso o erro REFINA a leitura, não
--      decide a classe.
--
-- O que esta camada NÃO faz: não entra no motor. `replenishment_calc` não lê
-- nada daqui — o núcleo matemático está congelado. XYZ é lente, não alavanca.
--
-- Honestidade de formato (acordado): a UI mostra
--   "AZ · erro histórico típico ±38% · 8 origens"
-- e nunca "confiança: 89%" — porcentagem única de confiança é pseudo-precisão.
-- Item com menos de 4 semanas de histórico não vira Z: vira "previsibilidade
-- ainda não classificada". Chamar lançamento de errático seria certeza falsa.

-- ---------------------------------------------------------------------------
-- 1. Cortes nos parâmetros versionados
--
-- ALTER + default não dispara o guard de append-only e flui pelo
-- `publish_replenishment_params` (jsonb_populate_record) sem mudar RPC — o
-- mesmo caminho de demand_model (0016) e sigma_anchor (0017). Os defaults JÁ
-- SÃO a calibração da Triana; outra empresa recalibra publicando versão nova.
-- ---------------------------------------------------------------------------

alter table public.replenishment_params
  add column xyz_cut_x numeric not null default 1.0,
  add column xyz_cut_y numeric not null default 1.6;

alter table public.replenishment_params
  add constraint replenishment_params_xyz_cuts_chk
  check (xyz_cut_x > 0 and xyz_cut_y > xyz_cut_x);

comment on column public.replenishment_params.xyz_cut_x is
  'CV ≤ este valor → classe X (previsível). Calibrado no tercil p33 da base da empresa.';
comment on column public.replenishment_params.xyz_cut_y is
  'CV ≤ este valor → classe Y; acima → Z (errático). Calibrado no tercil p66.';

-- ---------------------------------------------------------------------------
-- 2. Erro histórico do forecast, por SKU
--
-- Porta o backtest rolling (scripts/backtest-demand-rolling.sql) para dentro
-- do banco, só para o modelo vivo (weighted_90_180), agregado por SKU.
-- Horizontes 8/12/16 semanas: 4 é ruído de uma semana de sorte, 24 quase não
-- tem origem elegível; 8–16 é a faixa em que a decisão de compra vive.
--
-- wMAPE nulo = o realizado somou zero em todas as janelas avaliadas. Não é
-- "erro zero" nem "erro infinito": é "sem métrica honesta" — a UI mostra
-- "sem erro medido", não um número.
-- ---------------------------------------------------------------------------

create table public.forecast_accuracy (
  company_id  uuid    not null references public.companies(id) on delete cascade,
  sku_norm    text    not null,
  model       text    not null,
  wmape       numeric,          -- Σ|prev−real| / Σreal; nulo = sem venda no realizado
  bias        numeric,          -- Σ(prev−real) / Σreal; + superestima, − subestima
  origins_n   integer not null, -- cortes de backtest em que o SKU já existia
  horizons    int[]   not null, -- horizontes agregados (semanas)
  computed_at timestamptz not null default now(),
  primary key (company_id, sku_norm, model)
);

alter table public.forecast_accuracy enable row level security;

create policy forecast_accuracy_select on public.forecast_accuracy
  for select to authenticated
  using (company_id = any (public.my_company_ids()));

-- Sem política de escrita: só a função de rebuild (definer) escreve.
grant select on public.forecast_accuracy to authenticated;
grant select, insert, update, delete on public.forecast_accuracy to service_role;

create or replace function public.forecast_accuracy_rebuild(_company_id uuid)
returns integer
language plpgsql
security definer
set search_path to 'public', 'pg_catalog'
as $$
declare
  _n integer;
begin
  -- Usuário logado precisa de papel na empresa. Chamada sem JWT (cron, como
  -- postgres) passa — anon não alcança a função (EXECUTE revogado abaixo).
  if auth.uid() is not null
     and not public.has_company_role(_company_id, 'owner', 'gestor', 'operador') then
    raise exception 'sem permissão para recalcular acurácia nesta empresa'
      using errcode = '42501';
  end if;

  delete from public.forecast_accuracy
  where company_id = _company_id and model = 'weighted_90_180';

  insert into public.forecast_accuracy
    (company_id, sku_norm, model, wmape, bias, origins_n, horizons)
  with bounds as (
    select min(sold_on) as first_sale, max(sold_on) as last_sale
    from public.sales_order_items
    where company_id = _company_id and not shadow
  ),
  -- Cortes a cada 28 dias. Elegibilidade por par (corte, horizonte): o D180
  -- precisa caber antes do corte e o realizado precisa caber antes do fim da
  -- base — senão o modelo enxergaria janela truncada e a comparação seria
  -- injusta (mesma regra do script de backtest).
  grid as (
    select c.cutoff::date as cutoff, h.weeks as horizon
    from bounds b
    cross join generate_series(b.first_sale + 182, b.last_sale, interval '28 days') c(cutoff)
    cross join (values (8), (12), (16)) h(weeks)
    where c.cutoff::date + h.weeks * 7 <= b.last_sale
  ),
  sales as (
    select s.sku_norm, s.sold_on, s.qty
    from public.sales_order_items s
    where s.company_id = _company_id and not s.shadow and s.sku_norm is not null
  ),
  per as (
    select
      g.cutoff, g.horizon, s.sku_norm,
      min(s.sold_on) filter (where s.sold_on <= g.cutoff) as first_sale,
      coalesce(sum(s.qty) filter (where s.sold_on > g.cutoff - 91  and s.sold_on <= g.cutoff), 0) / 13.0 as d90,
      coalesce(sum(s.qty) filter (where s.sold_on > g.cutoff - 182 and s.sold_on <= g.cutoff), 0) / 26.0 as d180,
      coalesce(sum(s.qty) filter (where s.sold_on > g.cutoff
                                    and s.sold_on <= g.cutoff + g.horizon * 7), 0)
        / g.horizon::numeric as actual
    from grid g
    cross join sales s
    group by g.cutoff, g.horizon, s.sku_norm
  ),
  agg as (
    select
      p.sku_norm,
      sum(abs(0.7 * p.d90 + 0.3 * p.d180 - p.actual)) as sae,
      sum(     0.7 * p.d90 + 0.3 * p.d180 - p.actual) as se,
      sum(p.actual)                                   as sa,
      count(distinct p.cutoff)::int                   as origins_n
    from per p
    -- Só cortes em que o SKU já existia: antes da 1ª venda não há previsão a
    -- avaliar (mesmo princípio do sigma_anchor: ausência de observação ≠ zero).
    where p.first_sale is not null and p.first_sale <= p.cutoff
    group by p.sku_norm
  )
  select
    _company_id, a.sku_norm, 'weighted_90_180',
    round(a.sae / nullif(a.sa, 0), 3),
    round(a.se  / nullif(a.sa, 0), 3),
    a.origins_n,
    array[8, 12, 16]
  from agg a;

  get diagnostics _n = row_count;
  return _n;
end;
$$;

revoke all on function public.forecast_accuracy_rebuild(uuid) from public;
revoke all on function public.forecast_accuracy_rebuild(uuid) from anon;
revoke all on function public.forecast_accuracy_rebuild(uuid) from authenticated;
grant execute on function public.forecast_accuracy_rebuild(uuid) to authenticated;

-- Primeira carga agora — a métrica nasce no deploy, não no domingo.
select public.forecast_accuracy_rebuild(id) from public.companies;

-- Um corte novo de backtest só aparece a cada ~28 dias de venda; semanal é
-- mais que suficiente. Domingo 06:50 UTC = 03:50 BRT, depois dos diários.
select cron.schedule('forecast-accuracy-weekly', '50 6 * * 0',
  $$select public.forecast_accuracy_rebuild(id) from public.companies$$);
