-- 0007_engine — o motor de reposição.
--
-- O cálculo vive numa única função SQL e grava um SNAPSHOT imutável. Todas as
-- telas leem do mesmo `snapshot_id`, e não recalculam por conta própria: é
-- assim que o painel, a curva ABC e o pedido de compra param de discordar
-- entre si quando alguém importa um arquivo no meio da navegação.
--
-- Aritmética em `numeric`, não `double precision`. `round(numeric)` no Postgres
-- arredonda meio-para-longe-de-zero, igual ao ROUND do Excel; `round(double)`
-- arredonda para o par mais próximo e divergiria em todo valor terminado em
-- ,5 — o que acontece o tempo todo em `EMax = PP + demanda × ciclo`.

create table public.replenishment_snapshots (
  id             uuid primary key default gen_random_uuid(),
  company_id     uuid not null references public.companies (id) on delete cascade,
  params_id      uuid not null references public.replenishment_params (id),
  params_version integer not null,

  reference_date         date not null,
  today_effective        date not null,
  global_first_sale_date date,
  history_weeks          integer not null default 0,

  item_count       integer not null default 0,
  in_collection    integer not null default 0,
  abc_a            integer not null default 0,
  abc_b            integer not null default 0,
  abc_c            integer not null default 0,
  order_lines      integer not null default 0,
  order_pieces     numeric(16, 4) not null default 0,

  -- Os sete agregados do `Variáveis`, nas duas bases (preço de venda / custo).
  totals jsonb not null default '{}'::jsonb,

  note       text,
  created_by uuid references auth.users (id) on delete set null,
  created_at timestamptz not null default now()
);

create index replenishment_snapshots_company_idx
  on public.replenishment_snapshots (company_id, created_at desc);

create table public.replenishment_snapshot_items (
  snapshot_id uuid not null references public.replenishment_snapshots (id) on delete cascade,
  product_id  uuid not null references public.products (id) on delete cascade,
  company_id  uuid not null references public.companies (id) on delete cascade,

  sku        text,
  name       text,
  source_row integer,

  stock_total numeric(16, 4) not null default 0,  -- E
  sale_price  numeric(14, 4) not null default 0,  -- F
  cmv_raw     numeric(14, 4),                     -- G
  cmv_suspect boolean not null default false,     -- H
  cmv_used    numeric(14, 6) not null default 0,  -- I

  first_sale_date  date,            -- J
  weeks_in_catalog numeric(16, 8),  -- K  (nulo quando o item nunca vendeu)
  total_sales      numeric(16, 4) not null default 0,  -- L
  weekly_all       numeric(18, 10) not null default 0, -- M
  weekly_recent    numeric(18, 10) not null default 0, -- N
  weekly_blended   numeric(18, 10) not null default 0, -- O
  -- Sem escala fixa: é `taxa semanal × preço`, e a taxa já é uma dízima
  -- (85/51,714...). Truncar em 8 casas aqui divergiria da planilha, que guarda
  -- o float inteiro — e é por esta coluna que a curva ABC ordena.
  weekly_revenue   numeric not null default 0,         -- P

  sigma          numeric(18, 10) not null default 0,   -- Q
  sigma_weeks    integer,
  -- Menos de 4 semanas de histórico dá um σ que não significa nada. Marcar é
  -- melhor do que esconder: o número continua no lugar, mas a tela avisa.
  low_confidence boolean not null default false,

  abc_class      text,              -- R
  abc_cum_pct    numeric(12, 10),
  z              numeric(18, 12),   -- S

  safety_stock   numeric(16, 4),    -- T
  reorder_point  numeric(16, 4),    -- U
  max_stock      numeric(16, 4),    -- V
  in_transit     numeric(16, 4) not null default 0,   -- W

  in_collection  boolean not null default false,      -- X
  should_order   boolean not null default false,      -- Y
  qty_to_order   numeric(16, 4) not null default 0,   -- Z

  primary key (snapshot_id, product_id)
);

create index replenishment_snapshot_items_order_idx
  on public.replenishment_snapshot_items (snapshot_id)
  where should_order;

create index replenishment_snapshot_items_abc_idx
  on public.replenishment_snapshot_items (snapshot_id, abc_class);

alter table public.replenishment_snapshots      enable row level security;
alter table public.replenishment_snapshot_items enable row level security;

create policy replenishment_snapshots_select on public.replenishment_snapshots
  for select to authenticated using (company_id = any (public.my_company_ids()));
create policy replenishment_snapshot_items_select on public.replenishment_snapshot_items
  for select to authenticated using (company_id = any (public.my_company_ids()));

-- Sem policy de escrita: snapshot só nasce por `replenishment_compute()`.

grant select on public.replenishment_snapshots      to authenticated;
grant select on public.replenishment_snapshot_items to authenticated;

-- ============================================================== o cálculo
--
-- Uma view não serve porque o resultado precisa ser congelado, e uma função
-- `returns table` também não: o PostgREST corta a resposta em 1000 linhas sem
-- erro nenhum. Por isso `replenishment_compute` devolve só o uuid e o cliente
-- pagina `replenishment_snapshot_items` por conta própria.

create or replace function public.replenishment_calc(
  _company_id uuid,
  _p public.replenishment_params
)
returns table (
  product_id uuid, sku text, name text, source_row integer,
  stock_total numeric, sale_price numeric, cmv_raw numeric,
  cmv_suspect boolean, cmv_used numeric,
  first_sale_date date, weeks_in_catalog numeric, total_sales numeric,
  weekly_all numeric, weekly_recent numeric, weekly_blended numeric,
  weekly_revenue numeric,
  sigma numeric, sigma_weeks integer, low_confidence boolean,
  abc_class text, abc_cum_pct numeric, z numeric,
  safety_stock numeric, reorder_point numeric, max_stock numeric,
  in_transit numeric, in_collection boolean, should_order boolean,
  qty_to_order numeric,
  reference_date date, today_effective date,
  global_first_sale_date date, history_weeks integer
)
language sql
stable
set search_path = public, pg_catalog
as $$
with
-- O relógio e a régua. Tudo o mais depende destas três datas, então elas são
-- resolvidas uma única vez e carregadas adiante por CROSS JOIN.
ref as (
  select
    coalesce(_p.today_override, current_date) as today_effective,
    (select max(i.sold_on) from public.sales_order_items i
      where i.company_id = _company_id
        and (_p.sales_cutoff_on is null or i.sold_on <= _p.sales_cutoff_on)
    ) as max_sale_date,
    (select min(i.sold_on) from public.sales_order_items i
      where i.company_id = _company_id
        and (_p.sales_cutoff_on is null or i.sold_on <= _p.sales_cutoff_on)
    ) as global_first_sale_date
),
r as (
  select
    ref.today_effective,
    ref.global_first_sale_date,
    case
      when _p.reference_date_mode = 'today' then ref.today_effective
      else coalesce(ref.max_sale_date, ref.today_effective)
    end as reference_date
  from ref
),
-- Quantas semanas de 7 dias cabem entre a primeira venda da EMPRESA (não do
-- item) e a data de referência. É a grade em que o desvio-padrão é medido:
-- ancorar por item daria a cada SKU uma régua diferente.
weeks as (
  select r.*,
    case
      when r.global_first_sale_date is null then 0
      else ((r.reference_date - r.global_first_sale_date) / 7)::int + 1
    end as history_weeks
  from r
),
base as (
  select
    p.id as product_id, p.sku, p.sku_norm, p.sku_upper, p.name, p.source_row,
    p.sale_price, p.cmv,
    coalesce((
      select sum(ps.qty)
      from public.product_stock ps
      join public.warehouses w on w.id = ps.warehouse_id
      where ps.product_id = p.id and w.include_in_available
    ), 0) as stock_total
  from public.products p
  where p.company_id = _company_id and p.is_active
),
-- Chave de junção. Em modo legado é `upper(sku)` sem aparar, que é exatamente
-- o que o SUMIF/COUNTIF do Excel compara; em modo normalizado é `sku_norm`.
keyed as (
  select b.*,
    case when _p.sku_match_mode = 'exact' then b.sku_upper else b.sku_norm end as match_key
  from base b
),
sales_agg as (
  select
    i.sku_norm, i.sku_upper,
    min(i.sold_on) as first_sale_date,
    sum(i.qty) as total_sales,
    sum(i.qty) filter (
      where i.sold_on >= (
        case when _p.recent_window_anchor = 'today' then w.today_effective else w.reference_date end
      ) - _p.recent_window_days
    ) as recent_sales
  from public.sales_order_items i
  cross join weeks w
  where i.company_id = _company_id
    and (_p.sales_cutoff_on is null or i.sold_on <= _p.sales_cutoff_on)
  group by i.sku_norm, i.sku_upper
),
sales_keyed as (
  select
    case when _p.sku_match_mode = 'exact' then s.sku_upper else s.sku_norm end as match_key,
    min(s.first_sale_date) as first_sale_date,
    sum(s.total_sales) as total_sales,
    sum(coalesce(s.recent_sales, 0)) as recent_sales
  from sales_agg s
  group by 1
),
-- O produto cartesiano é deliberado: o desvio-padrão só faz sentido se as
-- semanas SEM venda entrarem como zero. Sem isso, um item que vendeu 3 peças
-- em 3 semanas distintas teria σ = 0 e estoque de segurança zero.
-- Custo: ~600 SKUs × ~53 semanas.
buckets as (
  select
    k.product_id,
    g.bucket,
    coalesce(sum(i.qty), 0) as qty
  from keyed k
  cross join weeks w
  cross join lateral generate_series(0, greatest(w.history_weeks - 1, 0)) as g(bucket)
  left join public.sales_order_items i
    on i.company_id = _company_id
   and (case when _p.sku_match_mode = 'exact' then i.sku_upper else i.sku_norm end) = k.match_key
   and (_p.sales_cutoff_on is null or i.sold_on <= _p.sales_cutoff_on)
   and ((i.sold_on - w.global_first_sale_date) / 7) = g.bucket
  where w.history_weeks > 0
  group by k.product_id, g.bucket
),
sigma_calc as (
  select
    b.product_id,
    stddev_samp(b.qty) as sigma,
    count(*)::int as sigma_weeks
  from buckets b
  group by b.product_id
),
sigma_pick as (
  select
    k.product_id,
    case
      when _p.sigma_source = 'external' then coalesce((
        select es.sigma from public.external_sigma es
        where es.company_id = _company_id
          and (case when _p.sku_match_mode = 'exact' then es.sku_upper else es.sku_norm end)
              = k.match_key
        limit 1
      ), 0)
      else coalesce(sc.sigma, 0)
    end as sigma,
    sc.sigma_weeks
  from keyed k
  left join sigma_calc sc on sc.product_id = k.product_id
),
transit as (
  select
    case when _p.sku_match_mode = 'exact' then poi.sku_upper else poi.sku_norm end as match_key,
    sum(poi.qty_open) as qty
  from public.purchase_order_items poi
  join public.purchase_orders po on po.id = poi.order_id
  where poi.company_id = _company_id
    and po.status in ('open', 'draft')
  group by 1
),
derived as (
  select
    k.product_id, k.sku, k.name, k.source_row, k.match_key,
    k.stock_total, k.sale_price, k.cmv,
    w.reference_date, w.today_effective, w.global_first_sale_date, w.history_weeks,

    -- H: CMV igual ao preço de venda é erro de cadastro, não margem zero.
    -- O `is not null` não é decoração: `cmv` é anulável de propósito ("não
    -- informado" é diferente de "custo zero") e sem isto a coluna sai NULA, o
    -- que é outra coisa que "não é suspeito".
    (k.cmv is not null and k.sale_price = k.cmv) as cmv_suspect,
    -- I: só o CMV informado E plausível é usado; o resto vira percentual.
    case
      when k.sale_price <> coalesce(k.cmv, -1) and coalesce(k.cmv, 0) > 0 then k.cmv
      else k.sale_price * _p.cmv_pct
    end as cmv_used,

    sk.first_sale_date,
    -- K: piso de 4 semanas. Um lançamento com 3 dias de vida dividiria a venda
    -- por 0,43 e projetaria uma demanda absurda.
    case
      when sk.first_sale_date is null then null
      else greatest((w.reference_date - sk.first_sale_date)::numeric / 7, 4)
    end as weeks_in_catalog,
    coalesce(sk.total_sales, 0) as total_sales,
    coalesce(sk.recent_sales, 0) as recent_sales,

    sp.sigma, sp.sigma_weeks,
    coalesce(t.qty, 0) as in_transit,

    (   not exists (
          select 1 from public.discontinued_items d
          where d.company_id = _company_id
            and (case when _p.sku_match_mode = 'exact' then d.sku_upper else d.sku_norm end)
                = k.match_key
        )
     and k.match_key is not null
     and coalesce(sk.total_sales, 0) > 0
    ) as in_collection
  from keyed k
  cross join weeks w
  left join sales_keyed sk on sk.match_key = k.match_key
  left join sigma_pick  sp on sp.product_id = k.product_id
  left join transit     t  on t.match_key = k.match_key
),
rates as (
  select d.*,
    -- M: sem venda, sem taxa. `weeks_in_catalog` nulo não vira divisão por zero.
    case when d.weeks_in_catalog is null or d.weeks_in_catalog = 0
         then 0 else d.total_sales / d.weeks_in_catalog end as weekly_all,
    d.recent_sales / (_p.recent_window_days::numeric / 7) as weekly_recent
  from derived d
),
blended as (
  select r.*,
    (r.weekly_all + r.weekly_recent) / 2 as weekly_blended
  from rates r
),
priced as (
  select b.*, b.weekly_blended * b.sale_price as weekly_revenue
  from blended b
),
-- A curva roda só sobre os itens em coleção. `source_row` é o desempate:
-- o SORTBY do Excel é estável, então empate de faturamento mantém a ordem do
-- arquivo de origem — sem isso, dois itens de mesma receita trocariam de
-- classe entre execuções e o Z mudaria junto.
abc_ordered as (
  select p.product_id, p.weekly_revenue * 52 as annual_revenue,
    row_number() over (order by p.weekly_revenue desc, p.source_row nulls last, p.sku) as rn
  from priced p
  where p.in_collection
),
abc as (
  select
    a.product_id,
    case
      when sum(a.annual_revenue) over () = 0 then null
      else sum(a.annual_revenue) over (order by a.rn rows between unbounded preceding and current row)
           / sum(a.annual_revenue) over ()
    end as cum_pct
  from abc_ordered a
),
classed as (
  select
    p.*,
    a.cum_pct as abc_cum_pct,
    case
      when a.cum_pct is null then null
      when a.cum_pct <= _p.abc_cut_a then 'A'
      when a.cum_pct <= _p.abc_cut_b then 'B'
      else 'C'
    end as abc_class
  from priced p
  left join abc a on a.product_id = p.product_id
),
zed as (
  select c.*,
    public.norm_s_inv(
      case c.abc_class
        when 'A' then _p.service_level_a
        when 'B' then _p.service_level_b
        -- Item sem classe (fora de coleção) recebe o nível C, o mais frouxo.
        else _p.service_level_c
      end::double precision
    )::numeric as z
  from classed c
),
final as (
  select z.*,
    -- T: teto, nunca arredondamento. Meia peça de segurança não existe, e
    -- arredondar para baixo é justamente o erro que a política de nível de
    -- serviço existe para evitar.
    case
      when z.in_collection or _p.safety_stock_for_out_of_collection
        then ceil(z.z * z.sigma * sqrt(_p.lead_time_days::numeric / 7))
      else null
    end as safety_stock
  from zed z
),
-- U: multiplica ANTES de dividir, e isso não é preciosismo. `80::numeric / 7`
-- fecha em escala 16 arredondando PARA CIMA (11,4285714285714286), então
-- `0,175 × isso` dá 2,000000000000000005 e o CEIL cobra uma peça que não
-- existe. Escrito como `O × 80 / 7` o mesmo caso fecha em 2 exato. Eram 6 SKUs
-- com PP e EMax uma peça acima da planilha, e R$ 1.511 a mais no estoque
-- máximo — o tipo de divergência que ninguém nota olhando a tela.
withpp as (
  select f.*,
    case when f.in_collection
      then ceil(coalesce(f.safety_stock, 0)
                + f.weekly_blended * _p.lead_time_days / 7)
      else null end as reorder_point
  from final f
),
withmax as (
  select w.*,
    case when w.in_collection
      then round(w.reorder_point + w.weekly_blended * _p.order_cycle_weeks)
      else null end as max_stock
  from withpp w
)
select
  m.product_id, m.sku, m.name, m.source_row,
  m.stock_total, m.sale_price, m.cmv, m.cmv_suspect, m.cmv_used,
  m.first_sale_date, m.weeks_in_catalog, m.total_sales,
  m.weekly_all, m.weekly_recent, m.weekly_blended, m.weekly_revenue,
  m.sigma, m.sigma_weeks, (coalesce(m.sigma_weeks, 0) < 4) as low_confidence,
  m.abc_class, m.abc_cum_pct, m.z,
  m.safety_stock, m.reorder_point, m.max_stock, m.in_transit,
  m.in_collection,
  (m.in_collection and m.stock_total + m.in_transit <= m.reorder_point) as should_order,
  case
    when m.in_collection and m.stock_total + m.in_transit <= m.reorder_point
      then m.max_stock - m.stock_total - m.in_transit
    else 0
  end as qty_to_order,
  m.reference_date, m.today_effective, m.global_first_sale_date, m.history_weeks
from withmax m;
$$;

revoke all on function public.replenishment_calc(uuid, public.replenishment_params) from public;
revoke all on function public.replenishment_calc(uuid, public.replenishment_params) from anon;
revoke all on function public.replenishment_calc(uuid, public.replenishment_params) from authenticated;

-- Os sete agregados de `Variáveis`, nas duas bases. Ficam numa função à parte
-- porque o preview precisa deles sem gravar nada.
create or replace function public.replenishment_totals(_rows jsonb)
returns jsonb
language sql
immutable
as $$
with i as (
  select
    (e ->> 'stock_total')::numeric   as e_stock,
    (e ->> 'sale_price')::numeric    as f_price,
    (e ->> 'cmv_used')::numeric      as i_cost,
    (e ->> 'safety_stock')::numeric  as t_safety,
    (e ->> 'max_stock')::numeric     as v_max,
    (e ->> 'in_collection')::boolean as x_in
  from jsonb_array_elements(_rows) as e
),
s as (
  select
    sum(e_stock * f_price)                                as cur_price,
    sum(e_stock * i_cost)                                 as cur_cost,
    sum(e_stock * f_price) filter (where not x_in)        as disc_price,
    sum(e_stock * i_cost)  filter (where not x_in)        as disc_cost,
    sum(e_stock * f_price) filter (where x_in)            as act_price,
    sum(e_stock * i_cost)  filter (where x_in)            as act_cost,
    sum(coalesce(t_safety, 0) * f_price)                  as saf_price,
    sum(coalesce(t_safety, 0) * i_cost)                   as saf_cost,
    sum(coalesce(v_max, 0) * f_price) filter (where x_in) as max_price,
    sum(coalesce(v_max, 0) * i_cost)  filter (where x_in) as max_cost
  from i
)
select jsonb_build_object(
  'current',       jsonb_build_array(coalesce(cur_price, 0), coalesce(cur_cost, 0)),
  'discontinued',  jsonb_build_array(coalesce(disc_price, 0), coalesce(disc_cost, 0)),
  'active',        jsonb_build_array(coalesce(act_price, 0), coalesce(act_cost, 0)),
  'safety',        jsonb_build_array(coalesce(saf_price, 0), coalesce(saf_cost, 0)),
  'max_active',    jsonb_build_array(coalesce(max_price, 0), coalesce(max_cost, 0)),
  -- O estoque médio de um modelo (s,S) é o de segurança mais meia reposição;
  -- a planilha escreve isso como a média entre o máximo e o de segurança.
  'average',       jsonb_build_array(
                     (coalesce(max_price, 0) + coalesce(saf_price, 0)) / 2,
                     (coalesce(max_cost, 0)  + coalesce(saf_cost, 0))  / 2),
  'max_with_discontinued', jsonb_build_array(
                     coalesce(max_price, 0) + coalesce(disc_price, 0),
                     coalesce(max_cost, 0)  + coalesce(disc_cost, 0))
) from s;
$$;

revoke all on function public.replenishment_totals(jsonb) from public;
revoke all on function public.replenishment_totals(jsonb) from anon;
revoke all on function public.replenishment_totals(jsonb) from authenticated;

-- ---------------------------------------------------------------- compute

create or replace function public.replenishment_compute(
  _company_id uuid,
  _note text default null
)
returns uuid
language plpgsql
security definer
set search_path = public, pg_catalog
as $$
declare
  _p    public.replenishment_params;
  _id   uuid;
  _head record;
begin
  -- SECURITY DEFINER desliga a RLS dentro do corpo, então a permissão é
  -- revalidada aqui à mão. Sem isto, qualquer autenticado calcularia (e leria,
  -- pelos agregados) o estoque de qualquer empresa.
  if not public.has_company_role(_company_id, 'owner', 'gestor', 'operador') then
    raise exception 'sem permissão para calcular reposição nesta empresa' using errcode = '42501';
  end if;

  select * into _p from public.replenishment_params
  where company_id = _company_id and is_current;

  if not found then
    raise exception 'empresa % não tem parâmetros de reposição', _company_id using errcode = 'P0002';
  end if;

  create temp table _calc on commit drop as
    select * from public.replenishment_calc(_company_id, _p);

  select
    max(c.reference_date)           as reference_date,
    max(c.today_effective)          as today_effective,
    min(c.global_first_sale_date)   as global_first_sale_date,
    coalesce(max(c.history_weeks), 0) as history_weeks
  into _head
  from _calc c;

  insert into public.replenishment_snapshots (
    company_id, params_id, params_version,
    reference_date, today_effective, global_first_sale_date, history_weeks,
    item_count, in_collection, abc_a, abc_b, abc_c, order_lines, order_pieces,
    totals, note, created_by
  )
  select
    _company_id, _p.id, _p.version,
    -- Empresa sem venda nenhuma ainda assim precisa de um snapshot válido.
    coalesce(_head.reference_date, coalesce(_p.today_override, current_date)),
    coalesce(_head.today_effective, coalesce(_p.today_override, current_date)),
    _head.global_first_sale_date,
    _head.history_weeks,
    count(*),
    count(*) filter (where c.in_collection),
    count(*) filter (where c.abc_class = 'A'),
    count(*) filter (where c.abc_class = 'B'),
    count(*) filter (where c.abc_class = 'C'),
    count(*) filter (where c.should_order),
    coalesce(sum(c.qty_to_order) filter (where c.should_order), 0),
    public.replenishment_totals(coalesce(jsonb_agg(to_jsonb(c)), '[]'::jsonb)),
    _note, auth.uid()
  from _calc c
  returning id into _id;

  insert into public.replenishment_snapshot_items (
    snapshot_id, product_id, company_id, sku, name, source_row,
    stock_total, sale_price, cmv_raw, cmv_suspect, cmv_used,
    first_sale_date, weeks_in_catalog, total_sales,
    weekly_all, weekly_recent, weekly_blended, weekly_revenue,
    sigma, sigma_weeks, low_confidence,
    abc_class, abc_cum_pct, z,
    safety_stock, reorder_point, max_stock, in_transit,
    in_collection, should_order, qty_to_order
  )
  select
    _id, c.product_id, _company_id, c.sku, c.name, c.source_row,
    c.stock_total, c.sale_price, c.cmv_raw, c.cmv_suspect, c.cmv_used,
    c.first_sale_date, c.weeks_in_catalog, c.total_sales,
    c.weekly_all, c.weekly_recent, c.weekly_blended, c.weekly_revenue,
    c.sigma, c.sigma_weeks, c.low_confidence,
    c.abc_class, c.abc_cum_pct, c.z,
    c.safety_stock, c.reorder_point, c.max_stock, c.in_transit,
    c.in_collection, c.should_order, c.qty_to_order
  from _calc c;

  drop table _calc;
  return _id;
end;
$$;

revoke all on function public.replenishment_compute(uuid, text) from public;
revoke all on function public.replenishment_compute(uuid, text) from anon;
revoke all on function public.replenishment_compute(uuid, text) from authenticated;
grant execute on function public.replenishment_compute(uuid, text) to authenticated;

-- ---------------------------------------------------------------- preview
--
-- O que o formulário de parâmetros chama enquanto o usuário digita: roda o
-- mesmo motor com um patch em memória e devolve SÓ os agregados e contagens.
-- Não grava nada e não devolve as 600 linhas — é o que permite recalcular a
-- cada tecla sem encher o banco de snapshots descartáveis.

create or replace function public.replenishment_preview(
  _company_id uuid,
  _overrides jsonb default '{}'::jsonb
)
returns jsonb
language plpgsql
security definer
stable
set search_path = public, pg_catalog
as $$
declare
  _p    public.replenishment_params;
  _rows jsonb;
  _out  jsonb;
begin
  if not public.user_can_access_company(_company_id) then
    raise exception 'sem acesso a esta empresa' using errcode = '42501';
  end if;

  select * into _p from public.replenishment_params
  where company_id = _company_id and is_current;

  if not found then
    raise exception 'empresa % não tem parâmetros de reposição', _company_id using errcode = 'P0002';
  end if;

  -- O patch não pode reescrever a identidade da versão: preview é simulação,
  -- não publicação.
  _p := jsonb_populate_record(
    _p,
    _overrides - 'id' - 'company_id' - 'version' - 'is_current' - 'created_by' - 'created_at'
  );

  select coalesce(jsonb_agg(to_jsonb(c)), '[]'::jsonb) into _rows
  from public.replenishment_calc(_company_id, _p) c;

  select jsonb_build_object(
    'totals', public.replenishment_totals(_rows),
    'item_count',    count(*),
    'in_collection', count(*) filter (where (e ->> 'in_collection')::boolean),
    'abc_a',         count(*) filter (where e ->> 'abc_class' = 'A'),
    'abc_b',         count(*) filter (where e ->> 'abc_class' = 'B'),
    'abc_c',         count(*) filter (where e ->> 'abc_class' = 'C'),
    'order_lines',   count(*) filter (where (e ->> 'should_order')::boolean),
    'order_pieces',  coalesce(sum((e ->> 'qty_to_order')::numeric)
                       filter (where (e ->> 'should_order')::boolean), 0),
    'reference_date', max(e ->> 'reference_date'),
    'history_weeks',  max((e ->> 'history_weeks')::int),
    'low_confidence', count(*) filter (where (e ->> 'low_confidence')::boolean)
  ) into _out
  from jsonb_array_elements(_rows) as e;

  return _out;
end;
$$;

revoke all on function public.replenishment_preview(uuid, jsonb) from public;
revoke all on function public.replenishment_preview(uuid, jsonb) from anon;
revoke all on function public.replenishment_preview(uuid, jsonb) from authenticated;
grant execute on function public.replenishment_preview(uuid, jsonb) to authenticated;
