-- 0011_sales_shadow — vendas do Tiny em modo shadow (fase 3).
--
-- O sync de pedidos ingere as vendas do Tiny NAS MESMAS tabelas das vendas
-- importadas, mas marcadas `shadow = true`. Linha shadow não alimenta o motor
-- nem os checks de saúde: ela existe para diffar contra o import (total mensal
-- por SKU) antes do corte. Motivo de não cortar direto: um filtro de situação
-- divergente (pedido cancelado contando, ou não) desloca toda a taxa semanal
-- em silêncio — o shadow é onde essa divergência aparece sem custar dinheiro.
--
-- O corte, quando vier, é um UPDATE datado (`shadow = false` + remoção do
-- período equivalente no canal manual), não um deploy.

alter table public.sales_orders      add column shadow boolean not null default false;
alter table public.sales_order_items add column shadow boolean not null default false;

-- O worker do Tiny escreve venda direto (sem RPC SECURITY DEFINER) — mesmo
-- racional dos grants tabela-a-tabela da 0009.
grant select, insert, update, delete on public.sales_orders      to service_role;
grant select, insert, update, delete on public.sales_order_items to service_role;

-- ---------------------------------------------------------------- motor
--
-- Mesmo corpo da 0007, com `and not i.shadow` nos quatro pontos que leem
-- `sales_order_items` (as duas datas de referência, o agregado por SKU e os
-- buckets do desvio-padrão). O harness de paridade garante que nada além do
-- filtro mudou: fixture não tem linha shadow, então o resultado é idêntico.

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
    ) as recent_sales
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

-- ---------------------------------------------------------------- saúde
--
-- Mesmo corpo da 0008, com `not shadow` nos checks que leem venda: SKU sem
-- produto, sobreposição de canal, pedidos com itens pendentes e a janela
-- morta. Sem o filtro, o backfill do Tiny (que roda por horas com
-- `items_fetched = false`) dispararia "pedidos pendentes" no banner — alarme
-- sobre linha que o motor nem enxerga.

create or replace function public.data_health_report(_company_id uuid)
returns jsonb
language plpgsql
security definer
stable
set search_path = public, pg_catalog
as $$
declare
  _sources jsonb;
  _checks  jsonb;
  _p       public.replenishment_params;
begin
  if not public.user_can_access_company(_company_id) then
    raise exception 'sem acesso a esta empresa' using errcode = '42501';
  end if;

  select * into _p from public.replenishment_params
  where company_id = _company_id and is_current;

  select coalesce(jsonb_agg(jsonb_build_object(
    'kind', k.kind,
    'provider', d.provider,
    'filename', d.filename,
    'row_count', coalesce(d.row_count, 0),
    'covers_until', d.covers_until,
    'refreshed_at', d.refreshed_at,
    -- 7 dias é o ciclo de decisão: a compra é semanal, então dado da semana
    -- passada ainda decide, dado de duas semanas atrás já não.
    'stale', d.refreshed_at is null or d.refreshed_at < now() - interval '7 days',
    'missing', d.company_id is null
  ) order by k.ord), '[]'::jsonb) into _sources
  from (values
    ('products'::public.import_kind, 1),
    ('sales', 2),
    ('in_transit', 3),
    ('discontinued', 4)
  ) as k(kind, ord)
  left join public.data_sources d on d.company_id = _company_id and d.kind = k.kind;

  with
  -- Os dois "sem produto" olham a EXISTÊNCIA do SKU no catálogo, e não a coluna
  -- `product_id`. A diferença importa: `product_id` é cache que o importador
  -- preenche, enquanto o motor casa por SKU na hora de calcular. Medir pelo
  -- cache faria esta tela discordar do snapshot sempre que a linha entrasse por
  -- outro caminho — e a tela que existe justamente para explicar os números
  -- seria a primeira a mentir sobre eles.
  unmatched as (
    select count(distinct i.sku_norm) as n
    from public.sales_order_items i
    where i.company_id = _company_id
      and not i.shadow
      and i.sku_norm is not null
      and not exists (
        select 1 from public.products p
        where p.company_id = _company_id and p.sku_norm = i.sku_norm
      )
  ),
  transit_unmatched as (
    select count(*) as n, coalesce(sum(poi.qty_open), 0) as qty
    from public.purchase_order_items poi
    join public.purchase_orders po on po.id = poi.order_id
    where poi.company_id = _company_id and po.status in ('open', 'draft')
      and not exists (
        select 1 from public.products p
        where p.company_id = _company_id and p.sku_norm = poi.sku_norm
      )
  ),
  -- Só conta quando o modo legado está ligado: é o dinheiro que a chave
  -- `sku_match_mode` libera, medido no dado real e não no exemplo do doc.
  --
  -- O `exists` daqui não é redundante com o de cima: peça cujo código não
  -- existe no catálogo está perdida de qualquer jeito, e somá-la aqui
  -- atribuiria ao espaço em branco um prejuízo que virar a chave não recupera.
  transit_lost as (
    select coalesce(sum(poi.qty_open), 0) as qty
    from public.purchase_order_items poi
    join public.purchase_orders po on po.id = poi.order_id
    where poi.company_id = _company_id and po.status in ('open', 'draft')
      and _p.sku_match_mode = 'exact'
      and poi.sku_upper is distinct from poi.sku_norm
      and exists (
        select 1 from public.products p
        where p.company_id = _company_id and p.sku_norm = poi.sku_norm
      )
  ),
  -- Mesma peça, mesmo dia, em mais de um canal. NÃO é prova de duplicata: a
  -- loja física e o Olist podem vender o mesmo SKU no mesmo dia, e isso é
  -- venda de verdade nos dois. Mas é também a assinatura exata do acidente que
  -- dobra a demanda inteira — `import_apply` só substitui o canal `manual`, e
  -- uma carga que entrou por outro canal fica embaixo da nova em vez de ser
  -- trocada. Os dois casos são indistinguíveis no dado, então isto avisa e
  -- explica; quem decide é quem sabe se a loja vendeu.
  overlap as (
    select count(*) as pairs, coalesce(sum(d.total - d.biggest), 0) as qty
    from (
      select sum(i.qty) as total, max(i.qty) as biggest
      from (
        select o.channel, i.sold_on, i.sku_norm, sum(i.qty) as qty
        from public.sales_order_items i
        join public.sales_orders o on o.id = i.order_id
        where i.company_id = _company_id and i.sku_norm is not null
          and not i.shadow
        group by o.channel, i.sold_on, i.sku_norm
      ) i
      group by i.sold_on, i.sku_norm
      having count(*) > 1
    ) d
  ),
  pending as (
    select count(*) as n from public.sales_orders
    where company_id = _company_id and not items_fetched and not shadow
  ),
  no_price as (
    select count(*) as n from public.products
    where company_id = _company_id and is_active and coalesce(sale_price, 0) = 0
  ),
  window_dead as (
    -- O achado 1, medido: a janela recente não pega venda nenhuma porque a
    -- âncora está à frente do fim da base.
    select (_p.recent_window_anchor = 'today'
            and coalesce(_p.today_override, current_date) - _p.recent_window_days
                > (select max(sold_on) from public.sales_order_items
                   where company_id = _company_id and not shadow)) as dead
  )
  select jsonb_build_object(
    'sales_skus_without_product', (select n from unmatched),
    'transit_items_without_product', (select n from transit_unmatched),
    'transit_qty_without_product', (select qty from transit_unmatched),
    'transit_qty_lost_to_whitespace', (select qty from transit_lost),
    'sales_overlapping_pairs', (select pairs from overlap),
    'sales_overlapping_qty', (select qty from overlap),
    'orders_pending_items', (select n from pending),
    'products_without_price', (select n from no_price),
    'recent_window_dead', coalesce((select dead from window_dead), false)
  ) into _checks;

  return jsonb_build_object(
    'sources', _sources,
    'checks', _checks,
    'params', jsonb_build_object(
      'version', _p.version,
      'recent_window_anchor', _p.recent_window_anchor,
      'sku_match_mode', _p.sku_match_mode,
      'sigma_source', _p.sigma_source,
      'safety_stock_for_out_of_collection', _p.safety_stock_for_out_of_collection
    ),
    -- O que impede de GERAR PEDIDO. Nada mais bloqueia.
    'blocking', (
      select coalesce(jsonb_agg(b), '[]'::jsonb) from (
        select 'Estoque nunca foi importado.' as b
        where not exists (select 1 from public.data_sources
                          where company_id = _company_id and kind = 'products')
        union all
        select 'Vendas nunca foram importadas.'
        where not exists (select 1 from public.data_sources
                          where company_id = _company_id and kind = 'sales')
        union all
        select 'Nenhum produto ativo no catálogo.'
        where not exists (select 1 from public.products
                          where company_id = _company_id and is_active)
      ) x
    )
  );
end;
$$;

revoke all on function public.data_health_report(uuid) from public;
revoke all on function public.data_health_report(uuid) from anon;
revoke all on function public.data_health_report(uuid) from authenticated;
grant execute on function public.data_health_report(uuid) to authenticated;
