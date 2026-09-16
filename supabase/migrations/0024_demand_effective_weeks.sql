-- Semanas efetivas no modelo 90/180.
--
-- O `weighted_90_180` divide a venda de 90 e 180 dias por 13 e 26 semanas
-- fixas, sem olhar quando o SKU nasceu. Para um produto com 7 semanas de vida
-- isso conta 19 semanas de venda zero que nunca aconteceram — a taxa semanal
-- sai por volta de um terço da real, e com ela o ponto de pedido e o estoque
-- máximo. É o mesmo erro que a v5 já tinha reconhecido no desvio-padrão
-- (`sigma_anchor = 'sku_first_sale'`) e deixado de pé na demanda.
--
-- Prova no dado: o SKU 1459757526 da All Out tem 7,4 semanas de vida, vendeu
-- 25 peças, e o snapshot gravou `demand_180d_weekly = 0,96` — exatamente
-- 25 ÷ 26. Com semanas efetivas seriam 25 ÷ 7,4 = 3,38.
--
-- A correção nasce DESLIGADA (`fixed`). Mudar divisor muda ponto de pedido de
-- todo lançamento do catálogo de uma vez; isso tem que ser um evento datado,
-- com versão de parâmetro e snapshot dos dois lados, não um efeito colateral
-- de migration.

do $$ begin
  create type public.demand_window_basis as enum ('fixed', 'effective');
exception when duplicate_object then null; end $$;

alter table public.replenishment_params
  add column if not exists demand_window_basis public.demand_window_basis
    not null default 'fixed';

-- Só o `rates` CTE muda (divisor das janelas de 90/180); colunas de retorno
-- idênticas às da 0021, então `create or replace` preserva ACL — sem DROP,
-- sem re-revoke.
create or replace function public.replenishment_calc(_company_id uuid, _p public.replenishment_params)
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
    -- Em 'disponivel' desconta-se a reserva POR LINHA, sem clamp: um depósito
    -- com mais reserva que saldo fica negativo aqui de propósito — é o mesmo
    -- número que o Tiny mostra, e mascará-lo esconderia a ruptura já vendida.
    coalesce((
      select sum(
        case when _p.stock_basis = 'disponivel'
          then ps.qty - ps.qty_reserved
          else ps.qty
        end)
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
--
-- Onde a série COMEÇA depende de sigma_anchor:
--   · global_history_legacy: bucket 0 (primeira venda da empresa) — o modo
--     da planilha, que trata pré-existência do SKU como demanda zero.
--   · sku_first_sale: do bucket da primeira venda do SKU em diante. Semana
--     anterior à primeira venda não é demanda zero — é ausência de
--     observação. A GRADE é a mesma da empresa (mesmas fronteiras), só se
--     cortam os buckets pré-existência. SKU sem venda nenhuma fica sem
--     observação válida (série vazia → σ nulo → 0 no sigma_pick).
buckets as (
  select
    k.product_id,
    g.bucket,
    coalesce(sum(i.qty), 0) as qty
  from keyed k
  cross join weeks w
  left join sales_keyed sk on sk.match_key = k.match_key
  cross join lateral generate_series(
    case
      when _p.sigma_anchor = 'sku_first_sale' then
        case when sk.first_sale_date is null
             then greatest(w.history_weeks, 1)  -- start > stop: série vazia
             else (sk.first_sale_date - w.global_first_sale_date) / 7
        end
      else 0
    end,
    greatest(w.history_weeks - 1, 0)
  ) as g(bucket)
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
    -- FALLBACK DOCUMENTADO: com n < 2 o desvio amostral (n−1) é indefinido e
    -- fica indefinido — nada de valor silencioso. O sigma_pick converte nulo
    -- em 0, então um lançamento com menos de 2 semanas de vida recebe ES = 0
    -- ATÉ a segunda semana, com low_confidence = true na tela (< 4 semanas).
    -- O lado da demanda já tem a proteção própria (piso de 4 semanas no
    -- weeks_in_catalog). No modo legado nada muda: stddev_samp já devolvia
    -- nulo com 1 linha; aqui isso só ganha nome.
    case when count(*) < 2 then null else stddev_samp(b.qty) end as sigma,
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
    --
    -- O divisor é a janela OU a idade do SKU, o que for menor. Dividir por 26
    -- semanas um produto que viveu 7 afirma 19 semanas de venda zero que nunca
    -- existiram: não é demanda baixa, é ausência de observação — o mesmo
    -- argumento que a v5 já aceitou para o σ, aplicado agora à demanda.
    -- `weeks_in_catalog` já traz o piso de 4 semanas, então não há como o
    -- divisor encolher a ponto de explodir a taxa de um lançamento de 3 dias.
    -- Null só acontece em SKU sem venda alguma, onde o numerador é 0 e o
    -- divisor é indiferente; cai no valor fixo para não gerar NULL.
    d.d90_sales / (case when _p.demand_window_basis = 'effective'
                        then least(13.0, coalesce(d.weeks_in_catalog, 13.0))
                        else 13.0 end) as demand_90d_weekly,
    d.d180_sales / (case when _p.demand_window_basis = 'effective'
                         then least(26.0, coalesce(d.weeks_in_catalog, 26.0))
                         else 26.0 end) as demand_180d_weekly
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
