-- 0036_dashboard_stalled — o estoque que parou de sair.
--
-- O cartão "Capital parado" do Painel responde QUANTO e por qual faixa. Esta
-- consulta responde QUAL e HÁ QUANTO TEMPO, que é o que se precisa saber para
-- fazer alguma coisa a respeito.
--
-- ---------------------------------------------------------------------------
-- POR QUE NÃO DAVA PARA REAPROVEITAR `in_collection` DO MOTOR.
--
-- No motor (0011 em diante), `in_collection` é
--
--     não está em discontinued_items  E  tem SKU casável  E  total_sales > 0
--
-- — as três coisas juntas numa só bandeira. Para o motor isso está certo: as
-- três significam "não projete demanda para este item". Mas na tela viram um
-- balde vermelho de R$ 521 mil em que convivem três problemas com três saídas
-- diferentes: o que foi tirado de linha de propósito, o que tem cadastro
-- quebrado e o que nunca vendeu uma peça. Aqui as três voltam a ser campos
-- separados (`discontinued`, `last_sale is null`) para a tela poder recomendar
-- coisas diferentes.
-- ---------------------------------------------------------------------------
--
-- "Parado há N dias" é medido contra a data de venda mais recente da EMPRESA, e
-- não contra `current_date` — mesmo motivo da 0022 e da 0032: sync parado há uma
-- semana envelheceria o catálogo inteiro em sete dias de uma vez.
--
-- O que NÃO dá para saber, e por isso não está aqui: há quanto tempo a PEÇA
-- está na prateleira. `qty_received` é zero em toda a base, então não existe
-- data de entrada. "Parado há 200 dias" é sobre a última SAÍDA, não sobre a
-- idade do estoque.

create or replace function public.dashboard_stalled(
  _company_id uuid,
  _min_days   int default 30
)
returns jsonb
language plpgsql
stable
security definer
set search_path = public, pg_catalog
as $$
declare
  _result     jsonb;
  _today      date;
  _base_start date;
  _mode       text;
  _cmv_pct    numeric;
begin
  if not public.user_can_access_company(_company_id) then
    raise exception 'sem acesso a esta empresa' using errcode = '42501';
  end if;

  select coalesce(max(sold_on), current_date), min(sold_on)
    into _today, _base_start
  from public.sales_orders where company_id = _company_id and not shadow;

  select coalesce(sku_match_mode, 'normalized'), coalesce(cmv_pct, 0.20)
    into _mode, _cmv_pct
  from public.replenishment_params
  where company_id = _company_id and is_current
  limit 1;

  _mode    := coalesce(_mode, 'normalized');
  _cmv_pct := coalesce(_cmv_pct, 0.20);

  with
  -- `include_in_available` é a MESMA definição do motor e da ficha de produto.
  -- Contar avaria e defeito aqui inflaria o capital parado com peça que já foi
  -- baixada, e a tela discordaria do Pedido de compra sobre quanto existe.
  stock as (
    select ps.product_id, sum(ps.qty)::numeric as qty
    from public.product_stock ps
    join public.warehouses w on w.id = ps.warehouse_id
    where ps.company_id = _company_id and w.include_in_available
    group by ps.product_id
    having sum(ps.qty) > 0
  ),
  -- Vida inteira por produto, não a janela: a pergunta é quando foi a ÚLTIMA
  -- venda, e uma janela de 90 dias não enxerga a diferença entre parado há 91
  -- dias e nunca vendido — que é justamente a diferença que mais importa.
  life as (
    select i.product_id,
           min(i.sold_on) as first_sale,
           max(i.sold_on) as last_sale,
           sum(i.qty)     as total_units,
           coalesce(sum(i.qty) filter (where i.sold_on > _today - 90), 0) as units_90
    from public.sales_order_items i
    join public.sales_orders o on o.id = i.order_id
    where i.company_id = _company_id and not i.shadow and not o.shadow
      and i.product_id is not null
    group by i.product_id
  ),
  -- Por GRADE, quantos irmãos ainda venderam nos últimos 90 dias. Um tamanho
  -- morto num modelo que vende não é produto encalhado, é sortimento errado —
  -- e a saída é outra: não se liquida o modelo, corrige-se a próxima compra.
  grade as (
    select p.parent_external_id as pex,
           count(*)                                                  as size,
           count(*) filter (where l.last_sale > _today - 90)          as alive
    from public.products p
    left join life l on l.product_id = p.id
    where p.company_id = _company_id and p.parent_external_id is not null
    group by p.parent_external_id
  ),
  base as (
    select p.id, p.sku, p.name, p.image_url, p.is_active, p.variation_type,
           p.category, p.tags,
           pp.id   as parent_id,
           pp.name as parent_name,
           st.qty  as stock,
           -- MESMA regra do motor (coluna I da 0021/0024): CMV igual ao preço
           -- de venda é erro de cadastro, e CMV ausente vira percentual do
           -- preço. Recalcular aqui com `coalesce(cmv, 0)` faria o capital
           -- parado desta tela sair menor que o do Painel na mesma peça — e a
           -- Triana, que veio de planilha e não tem custo em SKU nenhum,
           -- apareceria com R$ 0 de encalhe.
           u.cmv_used                as cmv,
           st.qty * u.cmv_used       as cost,
           l.first_sale, l.last_sale,
           coalesce(l.total_units, 0) as total_units,
           coalesce(l.units_90, 0)    as units_90,
           coalesce(g.size, 0)        as grade_size,
           coalesce(g.alive, 0)       as grade_alive,
           exists (
             select 1 from public.discontinued_items d
             where d.company_id = _company_id
               and (case when _mode = 'exact' then d.sku_upper else d.sku_norm end)
                 = (case when _mode = 'exact' then p.sku_upper else p.sku_norm end)
           ) as discontinued
    from public.products p
    join stock st on st.product_id = p.id
    cross join lateral (
      select case
        when coalesce(p.sale_price, 0) <> coalesce(p.cmv, -1) and coalesce(p.cmv, 0) > 0
          then p.cmv
        else coalesce(p.sale_price, 0) * _cmv_pct
      end as cmv_used
    ) u
    left join life  l on l.product_id = p.id
    left join grade g on g.pex = p.parent_external_id
    left join public.products pp
      on pp.company_id = p.company_id and pp.external_id = p.parent_external_id
    where p.company_id = _company_id
  ),
  stalled as (
    select * from base
    where last_sale is null or last_sale <= _today - greatest(_min_days, 1)
  )
  select jsonb_build_object(
    'reference_date', _today,
    'base_start',     _base_start,
    'min_days',       greatest(_min_days, 1),
    -- Denominador de tudo que a tela expressa em percentual: o estoque INTEIRO
    -- com saldo, parado ou não. Sem ele "R$ 300 mil encalhados" não tem
    -- tamanho — trezentos mil de dois milhões é um problema, de trezentos e
    -- dez mil é a empresa toda.
    'stock_cost',     (select coalesce(sum(cost), 0)  from base),
    'stock_pieces',   (select coalesce(sum(stock), 0) from base),
    'stock_skus',     (select count(*)                from base),
    'rows', (
      select coalesce(jsonb_agg(jsonb_build_object(
        'id', id, 'sku', sku, 'name', name, 'image_url', image_url,
        'is_active', is_active, 'variation_type', variation_type,
        'parent_id', parent_id, 'parent_name', parent_name,
        'category', category, 'tags', tags,
        'stock', stock, 'cmv', cmv, 'cost', cost,
        'first_sale', first_sale, 'last_sale', last_sale,
        -- Nulo quando nunca vendeu: zero diria "vendeu hoje" e um número
        -- grande inventaria uma data de entrada que não existe.
        'days', case when last_sale is null then null else (_today - last_sale) end,
        'total_units', total_units, 'units_90', units_90,
        'discontinued', discontinued,
        'grade_size', grade_size, 'grade_alive', grade_alive
      ) order by cost desc, stock desc), '[]'::jsonb)
      from stalled
    )
  )
  into _result;

  return _result;
end;
$$;

revoke all on function public.dashboard_stalled(uuid, int) from public;
revoke all on function public.dashboard_stalled(uuid, int) from anon;
revoke all on function public.dashboard_stalled(uuid, int) from authenticated;
grant execute on function public.dashboard_stalled(uuid, int) to authenticated;
