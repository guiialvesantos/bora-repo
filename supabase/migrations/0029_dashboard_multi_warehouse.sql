-- 0029_dashboard_multi_warehouse — o recorte de depósito vira CONJUNTO, e passa
-- a alcançar também os números que vêm do motor.
--
-- Duas mudanças, pelo mesmo motivo.
--
-- 1. `dashboard_census` recebia UM depósito. Quem opera com loja física + CD +
--    full de marketplace quase nunca quer um só: quer "os meus dois, sem o
--    full". Com escolha única isso não se escreve. O parâmetro vira `uuid[]`.
--    Troca de TIPO, não de nome — `create or replace` criaria uma sobrecarga e
--    o PostgREST passaria a ter duas assinaturas para o mesmo nome, escolhendo
--    uma por sorte do formato do JSON. Por isso o `drop` antes.
--
-- 2. `dashboard_stock_by_product` é nova e existe para consertar a assimetria
--    que a 0027 deixou: só a faixa de seis células obedecia ao filtro; os
--    quatro números grandes, a projeção, o capital parado e as duas barras
--    vinham do snapshot, que é agregado e não guarda depósito. A conta que
--    falta para eles não é nova nem é do motor — é a MESMA soma de `product_stock`
--    que o motor faz no CTE `base` da 0007, só que sobre os depósitos
--    escolhidos. Devolvida por produto, o cliente troca o `stock_total` de cada
--    linha do snapshot e refaz por cima dela a aritmética que já está na
--    própria linha (`safety_stock`, `reorder_point`, `max_stock` não dependem
--    de depósito: política é da empresa).
--
--    O que continua NÃO alcançável: canal e período. Os dois mexem na demanda
--    estimada, e demanda é o motor quem calcula — reescrever `weekly_blended`
--    no cliente seria rodar um segundo motor, pior, em JavaScript.

-- ------------------------------------------------------------------- censo

drop function if exists public.dashboard_census(uuid, uuid, text, date, date);

create or replace function public.dashboard_census(
  _company_id    uuid,
  _warehouse_ids uuid[] default null,
  _channel       text default null,
  _from          date default null,
  _to            date default null
)
returns jsonb
language plpgsql
stable
security definer
set search_path = public, pg_catalog
as $$
declare
  _result jsonb;
begin
  if not public.user_can_access_company(_company_id) then
    raise exception 'sem acesso a esta empresa' using errcode = '42501';
  end if;

  with
  -- Depósitos no recorte. Lista vazia é tratada igual a nula, e de propósito:
  -- desmarcar o último depósito na interface não pode significar "some com o
  -- estoque inteiro". Sem escolha, vale a MESMA definição do motor
  -- (`include_in_available`) — assim o censo sem filtro bate com a faixa de
  -- cima em vez de contar avaria e defeito junto.
  scope as (
    select w.id
    from public.warehouses w
    where w.company_id = _company_id
      and case
            when _warehouse_ids is null or cardinality(_warehouse_ids) = 0
              then w.include_in_available
            else w.id = any (_warehouse_ids)
          end
  ),
  stock as (
    select ps.product_id, sum(ps.qty) as qty
    from public.product_stock ps
    where ps.company_id = _company_id
      and ps.warehouse_id in (select id from scope)
    group by ps.product_id
  ),
  -- Colchão do cálculo corrente, só para dizer quem está "baixo". Se ainda
  -- não houve cálculo, a coluna vem nula e ninguém entra na conta de baixo —
  -- melhor do que chamar de baixo um item cujo piso ninguém definiu.
  current_snap as (
    select id from public.replenishment_snapshots
    where company_id = _company_id
    order by created_at desc
    limit 1
  ),
  safety as (
    select i.product_id, i.safety_stock, i.in_collection, i.cmv_used
    from public.replenishment_snapshot_items i
    join current_snap s on s.id = i.snapshot_id
  ),
  catalog as (
    select
      p.id,
      coalesce(st.qty, 0) as qty,
      -- O custo do motor, não o custo cru: a Triana não preenche `cmv` no
      -- produto e o motor deriva pelo `cmv_pct`. Usar só `p.cmv` daria
      -- "valor em estoque = R$ 0" numa empresa que tem 5.279 peças.
      coalesce(nullif(p.cmv, 0), sa.cmv_used, 0) as cmv,
      coalesce(p.sale_price, 0) as sale_price,
      sa.safety_stock,
      -- Sem `coalesce(..., true)`: produto que o motor ainda não avaliou não
      -- tem coleção nem colchão definidos. Chamá-lo de "em coleção, zerado"
      -- encheria o alerta de casos sobre os quais não se sabe nada.
      coalesce(sa.in_collection, false) as in_collection
    from public.products p
    left join stock st on st.product_id = p.id
    left join safety sa on sa.product_id = p.id
    where p.company_id = _company_id
      and p.is_active
  ),
  cat as (
    select
      count(*) as products,
      count(*) filter (where qty > 0) as with_stock,
      count(*) filter (where in_collection) as in_collection,
      coalesce(sum(qty), 0) as pieces,
      coalesce(sum(qty * cmv), 0) as stock_cost,
      coalesce(sum(qty * sale_price), 0) as stock_price,
      count(*) filter (where in_collection and qty = 0) as out_of_stock,
      count(*) filter (
        where in_collection and qty > 0
          and safety_stock is not null and qty < safety_stock
      ) as below_safety
    from catalog
  ),
  -- Venda no recorte. `not shadow` pelo mesmo motivo da 0011: linha em shadow
  -- existe para ser conferida contra a importada, não para ser somada duas
  -- vezes.
  sold as (
    select
      coalesce(sum(i.qty), 0) as units,
      coalesce(sum(i.qty * i.unit_price), 0) as revenue,
      count(distinct i.order_id) as orders,
      count(*) as lines
    from public.sales_order_items i
    join public.sales_orders o on o.id = i.order_id
    where i.company_id = _company_id
      and not i.shadow
      and not o.shadow
      -- `channel` é enum (`sales_channel`); o parâmetro chega como text do
      -- cliente. Cast na coluna, não no parâmetro: valor inválido vira
      -- "nenhum canal" em vez de erro 22P02 na cara do usuário.
      and (_channel is null or o.channel::text = _channel)
      and (_from is null or i.sold_on >= _from)
      and (_to is null or i.sold_on <= _to)
  ),
  -- Canais disponíveis: apurados SEM o filtro de canal, senão escolher um
  -- canal apagaria os outros da lista e prenderia o usuário nele.
  channels as (
    select coalesce(jsonb_agg(c order by c), '[]'::jsonb) as list
    from (
      select distinct o.channel::text as c
      from public.sales_orders o
      where o.company_id = _company_id and not o.shadow and o.channel is not null
    ) q
  )
  select jsonb_build_object(
    'products',     cat.products,
    'in_collection', cat.in_collection,
    'with_stock',   cat.with_stock,
    'pieces',       cat.pieces,
    'stock_cost',   cat.stock_cost,
    'stock_price',  cat.stock_price,
    'out_of_stock', cat.out_of_stock,
    'below_safety', cat.below_safety,
    'sold_units',   sold.units,
    'sold_revenue', sold.revenue,
    'orders',       sold.orders,
    'order_lines',  sold.lines,
    'channels',     channels.list,
    'has_snapshot', exists (select 1 from current_snap)
  )
  into _result
  from cat, sold, channels;

  return _result;
end;
$$;

revoke all on function public.dashboard_census(uuid, uuid[], text, date, date) from public;
revoke all on function public.dashboard_census(uuid, uuid[], text, date, date) from anon;
revoke all on function public.dashboard_census(uuid, uuid[], text, date, date) from authenticated;
grant execute on function public.dashboard_census(uuid, uuid[], text, date, date) to authenticated;

-- ------------------------------------------------- estoque por produto

-- Estoque por produto nos depósitos escolhidos, para reancorar os números do
-- snapshot no recorte da tela.
--
-- Só sai quem tem saldo diferente de zero. Produto ausente do objeto é lido
-- como zero pelo cliente — o que é a verdade e evita mandar 2.079 zeros pela
-- rede para uma empresa que guarda 300 SKUs num depósito.
--
-- jsonb e não RETURNS TABLE: o teto de 1000 linhas do PostgREST cortaria a
-- carteira no meio, em silêncio, e o Painel mostraria estoque a menos sem um
-- único erro no console.
create or replace function public.dashboard_stock_by_product(
  _company_id    uuid,
  _warehouse_ids uuid[] default null
)
returns jsonb
language plpgsql
stable
security definer
set search_path = public, pg_catalog
as $$
declare
  _result jsonb;
begin
  if not public.user_can_access_company(_company_id) then
    raise exception 'sem acesso a esta empresa' using errcode = '42501';
  end if;

  with scope as (
    select w.id
    from public.warehouses w
    where w.company_id = _company_id
      and case
            when _warehouse_ids is null or cardinality(_warehouse_ids) = 0
              then w.include_in_available
            else w.id = any (_warehouse_ids)
          end
  ),
  stock as (
    select ps.product_id, sum(ps.qty) as qty
    from public.product_stock ps
    where ps.company_id = _company_id
      and ps.warehouse_id in (select id from scope)
    group by ps.product_id
    having sum(ps.qty) <> 0
  )
  select coalesce(jsonb_object_agg(product_id::text, qty), '{}'::jsonb)
  into _result
  from stock;

  return _result;
end;
$$;

revoke all on function public.dashboard_stock_by_product(uuid, uuid[]) from public;
revoke all on function public.dashboard_stock_by_product(uuid, uuid[]) from anon;
revoke all on function public.dashboard_stock_by_product(uuid, uuid[]) from authenticated;
grant execute on function public.dashboard_stock_by_product(uuid, uuid[]) to authenticated;
