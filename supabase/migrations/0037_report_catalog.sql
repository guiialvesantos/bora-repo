-- 0037_report_catalog — o catálogo inteiro, inclusive o que esgotou.
--
-- ---------------------------------------------------------------------------
-- POR QUE NÃO DAVA PARA REAPROVEITAR `dashboard_stalled` NEM O SNAPSHOT.
--
-- Toda consulta de catálogo escrita até aqui carrega, no CTE `stock`, um
--
--     having sum(ps.qty) > 0
--
-- que é correto onde ela nasceu: encalhe, capital parado e pedido de compra são
-- perguntas sobre o que ESTÁ na prateleira. Só que sell-through de 100% é, por
-- definição, o produto que ZEROU — vendeu tudo. Aquele `having` apaga
-- exatamente a resposta.
--
-- Na All Out são 287 SKUs esgotados que já venderam (132 deles com 10 peças ou
-- mais, 3.831 peças no total). Um relatório de "sell-through acima de 80%"
-- montado sobre as RPCs existentes sairia sem nenhum deles: assinado, impresso,
-- e sem os campeões de venda da loja.
--
-- Por isso aqui o `stock` entra por LEFT JOIN e sem `having`: saldo zero é
-- zero, não é ausência. Quem quiser só o que tem prateleira filtra no cliente
-- (é o que o relatório de Posição de estoque faz).
-- ---------------------------------------------------------------------------
--
-- SELL-THROUGH É EXATO, MAS SÓ RESPONDE METADE DA PERGUNTA.
--
--     sell_through = vendidas / (vendidas + em estoque)
--
-- Os dois termos são contados, não estimados — daí ser exato. Mas ele é uma
-- PROPORÇÃO, e proporção não tem tamanho: vender 2 peças e zerar dá os mesmos
-- 100% de vender 300. Na All Out, 96 dos 643 SKUs acima de 80% venderam menos
-- de cinco peças (média 2,4) — ruído que, ordenado por percentual, sobe para o
-- topo da lista. Por isso `units_total` vai junto na linha e o relatório cobra
-- um piso de volume além do piso de percentual.
--
-- Não confundir com a "idade" da peça: `qty_received` é zero em toda a base,
-- então não existe data de entrada. Sell-through aqui é sobre a vida inteira do
-- SKU, não sobre uma temporada.

create or replace function public.report_catalog(
  _company_id uuid
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

  -- Mesma âncora da 0022/0032/0036: a data da última venda da EMPRESA, nunca
  -- `current_date`. Sync parado há uma semana envelheceria o catálogo inteiro
  -- em sete dias de uma vez, e um relatório datado herdaria o erro por escrito.
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
  -- `include_in_available` é a definição do motor e do Pedido de compra. Contar
  -- avaria e defeito aqui faria o relatório de Posição de estoque discordar do
  -- Painel sobre quanto existe — e é justamente o relatório que alguém leva
  -- para o contador.
  stock as (
    select ps.product_id, sum(ps.qty)::numeric as qty
    from public.product_stock ps
    join public.warehouses w on w.id = ps.warehouse_id
    where ps.company_id = _company_id and w.include_in_available
    group by ps.product_id
  ),
  life as (
    select i.product_id,
           min(i.sold_on) as first_sale,
           max(i.sold_on) as last_sale,
           sum(i.qty)     as units_total,
           coalesce(sum(i.qty) filter (where i.sold_on > _today - 90), 0) as units_90
    from public.sales_order_items i
    join public.sales_orders o on o.id = i.order_id
    where i.company_id = _company_id and not i.shadow and not o.shadow
      and i.product_id is not null
    group by i.product_id
  ),
  base as (
    select p.id, p.sku, p.name, p.category, p.tags,
           p.is_active, p.variation_type,
           pp.name as parent_name,
           -- LEFT JOIN, sem `having`: ver o cabeçalho. Saldo zero é um fato
           -- sobre o produto, não motivo para ele sumir do relatório.
           coalesce(st.qty, 0)        as stock,
           coalesce(p.sale_price, 0)  as sale_price,
           -- MESMA regra do motor (coluna I da 0021/0024) e da 0036: CMV igual
           -- ao preço é erro de cadastro, e CMV ausente vira percentual do
           -- preço. Sem isto a Triana, que veio de planilha e não tem custo em
           -- SKU nenhum, sairia com R$ 0 de estoque no relatório de posição.
           u.cmv_used                 as cmv,
           coalesce(st.qty, 0) * u.cmv_used                as cost,
           coalesce(st.qty, 0) * coalesce(p.sale_price, 0) as price_value,
           l.first_sale, l.last_sale,
           coalesce(l.units_total, 0) as units_total,
           coalesce(l.units_90, 0)    as units_90,
           exists (
             select 1 from public.discontinued_items d
             where d.company_id = _company_id
               and (case when _mode = 'exact' then d.sku_upper else d.sku_norm end)
                 = (case when _mode = 'exact' then p.sku_upper else p.sku_norm end)
           ) as discontinued
    from public.products p
    cross join lateral (
      select case
        when coalesce(p.sale_price, 0) <> coalesce(p.cmv, -1) and coalesce(p.cmv, 0) > 0
          then p.cmv
        else coalesce(p.sale_price, 0) * _cmv_pct
      end as cmv_used
    ) u
    left join stock st on st.product_id = p.id
    left join life  l  on l.product_id = p.id
    left join public.products pp
      on pp.company_id = p.company_id and pp.external_id = p.parent_external_id
    where p.company_id = _company_id
  )
  select jsonb_build_object(
    'reference_date', _today,
    'base_start',     _base_start,
    -- Os totais são do que TEM saldo: é o estoque da empresa, o denominador de
    -- qualquer percentual impresso. Produto esgotado entra nas linhas (para o
    -- sell-through enxergá-lo) mas não soma capital — ele não tem nenhum.
    'stock_cost',   (select coalesce(sum(cost), 0)        from base where stock > 0),
    'stock_price',  (select coalesce(sum(price_value), 0) from base where stock > 0),
    'stock_pieces', (select coalesce(sum(stock), 0)       from base where stock > 0),
    'stock_skus',   (select count(*)                      from base where stock > 0),
    'catalog_skus', (select count(*)                      from base),
    'rows', (
      select coalesce(jsonb_agg(jsonb_build_object(
        'id', id, 'sku', sku, 'name', name,
        'category', category, 'tags', tags,
        'is_active', is_active, 'variation_type', variation_type,
        'parent_name', parent_name, 'discontinued', discontinued,
        'stock', stock, 'sale_price', sale_price, 'cmv', cmv,
        'cost', cost, 'price_value', price_value,
        'first_sale', first_sale, 'last_sale', last_sale,
        'days', case when last_sale is null then null else (_today - last_sale) end,
        'units_total', units_total, 'units_90', units_90,
        -- Nulo quando o SKU nunca existiu de fato (não vendeu e não tem saldo):
        -- 0/0 não é zero por cento, é pergunta sem objeto.
        --
        -- `greatest(stock, 0)` no denominador porque saldo NEGATIVO existe: 25
        -- SKUs na All Out, -29 peças. Saldo negativo quer dizer que já saiu
        -- mais do que o sistema achava que tinha — isso é esgotado, 100%. Sem
        -- o piso a conta dava 8/(8-1) = 114,3%, e como o relatório ordena por
        -- percentual decrescente, os 25 casos de erro de saldo subiam na
        -- frente dos campeões de venda, no topo de uma folha assinada.
        'sell_through', case
          when units_total + greatest(stock, 0) > 0
            then units_total / (units_total + greatest(stock, 0))
        end
      ) order by name), '[]'::jsonb)
      from base
    )
  )
  into _result;

  return _result;
end;
$$;

revoke all on function public.report_catalog(uuid) from public;
revoke all on function public.report_catalog(uuid) from anon;
revoke all on function public.report_catalog(uuid) from authenticated;
grant execute on function public.report_catalog(uuid) to authenticated;
