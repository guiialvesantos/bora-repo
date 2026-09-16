-- 0016_demand_model — segundo modelo de demanda: weighted_90_180 (0,7·D90 + 0,3·D180).
--
-- Por quê: dois backtests contra a venda realizada (4 cortes fixos × 12
-- semanas, e rolling de 8 origens × horizontes 4–24 semanas, 2.264
-- observações) convergem no mesmo ranking. wMAPE geral / classe A:
--   0,7·D90+0,3·D180  0,458 / 0,321   ← vencedor em todo horizonte ≤16 sem
--   só D90            0,469 / 0,334   (challenger; segue nos backtests)
--   legado (vida+D28)/2  0,631 / 0,529
--   50/30/20 proposto  0,625 / 0,540  (empata com o legado — rejeitado)
--   só D28            0,854 / 0,793
-- Fator de tendência (D28/D90 grampeado) piora tudo — fora por ora.
--
-- O legado fica intacto e é o default: a troca é um evento de publish
-- versionado (params v4), com snapshot antes/depois e diff de impacto
-- revisado ANTES de ativar. `demand_model` nasce 'blended_legacy' justamente
-- para esta migration não mudar nenhum número por si só — o checksum do
-- cálculo em modo legado tem que ser idêntico pré/pós-migration.
--
-- Janelas do modelo novo: ancoradas em reference_date (não em today — a
-- âncora móvel foi o bug nº 1 da planilha), D90 = venda de 91 dias / 13,
-- D180 = venda de 182 dias / 26 — exatamente as janelas do backtest.
--
-- Explicabilidade: os itens do snapshot ganham demand_90d_weekly e
-- demand_180d_weekly (os insumos do modelo, gravados mesmo em modo legado),
-- e o cabeçalho ganha demand_model + demand_model_version — cada snapshot
-- declara com qual fórmula foi calculado.

do $$ begin
  create type public.demand_model as enum ('blended_legacy', 'weighted_90_180');
exception when duplicate_object then null; end $$;

-- ALTER ... ADD COLUMN não dispara o guard de append-only (trigger de linha),
-- e o default faz a linha corrente continuar legada. `publish_...` usa
-- jsonb_populate_record, então a coluna nova flui por patch sem mudar a RPC.
alter table public.replenishment_params
  add column if not exists demand_model public.demand_model not null default 'blended_legacy';

-- Cabeçalho: texto, não enum — snapshot é evidência histórica e não pode
-- quebrar se o enum evoluir. Versão da FÓRMULA (não dos params): incrementar
-- se pesos/janelas de um modelo mudarem.
alter table public.replenishment_snapshots
  add column if not exists demand_model text,
  add column if not exists demand_model_version integer;

alter table public.replenishment_snapshot_items
  add column if not exists demand_90d_weekly numeric,
  add column if not exists demand_180d_weekly numeric;

-- Mudança de colunas de retorno exige DROP (create or replace não altera o
-- OUT-set). Ninguém depende do tipo em catálogo: compute/preview chamam em
-- tempo de execução.
drop function if exists public.replenishment_calc(uuid, public.replenishment_params);

create function public.replenishment_calc(_company_id uuid, _p public.replenishment_params)
returns table(
  product_id uuid, sku text, name text, source_row integer,
  stock_total numeric, sale_price numeric, cmv_raw numeric, cmv_suspect boolean, cmv_used numeric,
  first_sale_date date, weeks_in_catalog numeric, total_sales numeric,
  weekly_all numeric, weekly_recent numeric, weekly_blended numeric, weekly_revenue numeric,
  demand_90d_weekly numeric, demand_180d_weekly numeric,
  sigma numeric, sigma_weeks integer, low_confidence boolean,
  abc_class text, abc_cum_pct numeric, z numeric,
  safety_stock numeric, reorder_point numeric, max_stock numeric, in_transit numeric,
  in_collection boolean, should_order boolean, qty_to_order numeric,
  reference_date date, today_effective date, global_first_sale_date date, history_weeks integer
)
language sql
stable
set search_path to 'public', 'pg_catalog'
as $function$
with
-- O relógio e a régua. Tudo o mais depende destas três datas, então elas são
-- resolvidas uma única vez e carregadas adiante por CROSS JOIN.
ref as (
  select
    coalesce(_p.today_override, current_date) as today_effective,
    (select max(i.sold_on) from public.sales_order_items i
      where i.company_id = _company_id
        and not i.shadow
        and (_p.sales_cutoff_on is null or i.sold_on <= _p.sales_cutoff_on)
    ) as max_sale_date,
    (select min(i.sold_on) from public.sales_order_items i
      where i.company_id = _company_id
        and not i.shadow
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
    ) as recent_sales,
    -- Janelas do weighted_90_180, sempre ancoradas em reference_date (o
    -- backtest é `> corte-91 and <= corte`; o teto explícito importa quando
    -- today_override recua o relógio no harness).
    sum(i.qty) filter (
      where i.sold_on > w.reference_date - 91 and i.sold_on <= w.reference_date
    ) as d90_sales,
    sum(i.qty) filter (
      where i.sold_on > w.reference_date - 182 and i.sold_on <= w.reference_date
    ) as d180_sales
  from public.sales_order_items i
  cross join weeks w
  where i.company_id = _company_id
    and not i.shadow
    and (_p.sales_cutoff_on is null or i.sold_on <= _p.sales_cutoff_on)
  group by i.sku_norm, i.sku_upper
),
sales_keyed as (
  select
    case when _p.sku_match_mode = 'exact' then s.sku_upper else s.sku_norm end as match_key,
    min(s.first_sale_date) as first_sale_date,
    sum(s.total_sales) as total_sales,
    sum(coalesce(s.recent_sales, 0)) as recent_sales,
    sum(coalesce(s.d90_sales, 0)) as d90_sales,
    sum(coalesce(s.d180_sales, 0)) as d180_sales
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
   and not i.shadow
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
    coalesce(sk.d90_sales, 0) as d90_sales,
    coalesce(sk.d180_sales, 0) as d180_sales,

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
    d.recent_sales / (_p.recent_window_days::numeric / 7) as weekly_recent,
    -- Insumos do weighted_90_180 — calculados (e gravados no snapshot) mesmo
    -- em modo legado, para o diff entre modelos ser auditável a qualquer tempo.
    d.d90_sales  / 13.0 as demand_90d_weekly,
    d.d180_sales / 26.0 as demand_180d_weekly
  from derived d
),
-- O único ponto onde o modelo escolhe. Tudo rio abaixo (receita, ABC, Z, PP,
-- EMax, sugestão) consome `weekly_blended` sem saber qual fórmula o gerou.
blended as (
  select r.*,
    case when _p.demand_model = 'weighted_90_180'
      then 0.7 * r.demand_90d_weekly + 0.3 * r.demand_180d_weekly
      else (r.weekly_all + r.weekly_recent) / 2
    end as weekly_blended
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
  m.demand_90d_weekly, m.demand_180d_weekly,
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
$function$;

-- CREATE FUNCTION dá EXECUTE a PUBLIC por default — o tríduo de sempre.
revoke all on function public.replenishment_calc(uuid, public.replenishment_params) from public;
revoke all on function public.replenishment_calc(uuid, public.replenishment_params) from anon;
revoke all on function public.replenishment_calc(uuid, public.replenishment_params) from authenticated;

-- compute: mesmas responsabilidades, agora gravando os insumos do modelo por
-- item e a identidade do modelo no cabeçalho.
create or replace function public.replenishment_compute(_company_id uuid, _note text default null)
returns uuid
language plpgsql
security definer
set search_path to 'public', 'pg_catalog'
as $function$
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
    totals, note, created_by, demand_model, demand_model_version
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
    _note, auth.uid(),
    _p.demand_model::text,
    -- Versão da FÓRMULA do modelo, não dos params: incrementar se os pesos ou
    -- as janelas de um modelo existente mudarem.
    1
  from _calc c
  returning id into _id;

  insert into public.replenishment_snapshot_items (
    snapshot_id, product_id, company_id, sku, name, source_row,
    stock_total, sale_price, cmv_raw, cmv_suspect, cmv_used,
    first_sale_date, weeks_in_catalog, total_sales,
    weekly_all, weekly_recent, weekly_blended, weekly_revenue,
    demand_90d_weekly, demand_180d_weekly,
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
    c.demand_90d_weekly, c.demand_180d_weekly,
    c.sigma, c.sigma_weeks, c.low_confidence,
    c.abc_class, c.abc_cum_pct, c.z,
    c.safety_stock, c.reorder_point, c.max_stock, c.in_transit,
    c.in_collection, c.should_order, c.qty_to_order
  from _calc c;

  drop table _calc;
  return _id;
end;
$function$;

revoke all on function public.replenishment_compute(uuid, text) from public;
revoke all on function public.replenishment_compute(uuid, text) from anon;
revoke all on function public.replenishment_compute(uuid, text) from authenticated;
grant execute on function public.replenishment_compute(uuid, text) to authenticated;

-- preview não muda: o patch jsonb já aceita `demand_model` via
-- jsonb_populate_record, e o to_jsonb do calc carrega os campos novos.
