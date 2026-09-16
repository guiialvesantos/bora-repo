-- 0031_dashboard_basket — o que sai junto, e o que puxa o quê.
--
-- Dois relatórios que saem da MESMA tabela de coocorrência, e por isso moram na
-- mesma função: rodar duas vezes o cruzamento de cesta para depois mostrar dois
-- cartões lado a lado seria pagar duas vezes pela mesma varredura.
--
--   pares  — quantas vezes A e B apareceram no mesmo pedido. Simétrico,
--            descritivo. Responde "o que costuma sair junto".
--   upsell — direcionado. Responde "de quem levou A, que fatia levou B também"
--            (confiança) e "isso é quantas vezes mais do que o acaso" (lift).
--
-- Por que os dois números, e não só a confiança: um item campeão aparece em
-- metade dos pedidos, então QUALQUER coisa tem 50% de confiança de puxá-lo.
-- Confiança sozinha só redescobre o mais vendido. O lift divide pela
-- frequência do sugerido — lift 1 é acaso, lift 20 é afinidade real. Ordenar
-- por lift e mostrar a confiança ao lado é o que separa "leve também uma
-- sacola" de "quem compra o colete leva a calça do mesmo conjunto".
--
-- ---------------------------------------------------------------------------
-- Duas decisões que mudam o resultado:
--
-- 1. VARIAÇÃO SOBE PARA O PAI. Sem isso, "Legging Preto M" e "Legging Preto G"
--    no mesmo pedido viram um "par", e o relatório passaria a ensinar que
--    calça vende junto com calça. O par que interessa é entre PRODUTOS.
--
-- 2. PISO DE PEDIDOS (`_min_orders`). Lift é uma razão, e razão sobre número
--    pequeno explode: dois produtos raríssimos que caíram no mesmo pedido uma
--    única vez dão lift de três dígitos e encabeçariam a lista para sempre. O
--    piso não é rigor estatístico, é a diferença entre um relatório e um
--    gerador de coincidências.
--
-- É relatório de VENDA: obedece a canal e período, não a depósito.

create or replace function public.dashboard_basket(
  _company_id uuid,
  _channel    text default null,
  _from       date default null,
  _to         date default null,
  _limit      int  default 5,
  _min_orders int  default 3
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
  -- A cesta: um pedido, os produtos DISTINTOS que ele contém. Distinto porque
  -- comprar dois tamanhos da mesma peça é um item na cesta, não dois.
  basket as (
    select distinct
      i.order_id,
      coalesce(pp.id, p.id)     as pid,
      coalesce(pp.name, p.name) as pname
    from public.sales_order_items i
    join public.sales_orders o on o.id = i.order_id
    join public.products p     on p.id = i.product_id
    left join public.products pp
      on pp.company_id = p.company_id
     and pp.external_id = p.parent_external_id
    where i.company_id = _company_id
      and not i.shadow
      and not o.shadow
      and (_channel is null or o.channel::text = _channel)
      and (_from is null or i.sold_on >= _from)
      and (_to is null or i.sold_on <= _to)
  ),
  scope as (
    select count(distinct order_id)::numeric as orders from basket
  ),
  item as (
    select pid, pname, count(*)::numeric as orders
    from basket
    group by pid, pname
  ),
  -- `b.pid > a.pid` em vez de `<>`: pega cada par uma vez só, e de quebra
  -- elimina o auto-par.
  pair as (
    select a.pid as a_id, b.pid as b_id, count(*)::numeric as orders
    from basket a
    join basket b on b.order_id = a.order_id and b.pid > a.pid
    group by a.pid, b.pid
    having count(*) >= greatest(_min_orders, 1)
  ),
  -- As duas leituras do mesmo par. O lift é o mesmo nos dois sentidos (a conta
  -- é simétrica); a confiança não é, e é ela que decide qual sentido vale a
  -- pena mostrar.
  directed as (
    select
      p.a_id as from_id, ia.pname as from_name, ia.orders as from_orders,
      p.b_id as to_id,   ib.pname as to_name,
      p.orders,
      p.orders / ia.orders                              as confidence,
      (p.orders / ia.orders) / (ib.orders / s.orders)   as lift
    from pair p
    join item ia on ia.pid = p.a_id
    join item ib on ib.pid = p.b_id
    cross join scope s
    union all
    select
      p.b_id, ib.pname, ib.orders,
      p.a_id, ia.pname,
      p.orders,
      p.orders / ib.orders,
      (p.orders / ib.orders) / (ia.orders / s.orders)
    from pair p
    join item ia on ia.pid = p.a_id
    join item ib on ib.pid = p.b_id
    cross join scope s
  ),
  best as (
    select distinct on (least(from_id, to_id), greatest(from_id, to_id)) *
    from directed
    order by least(from_id, to_id), greatest(from_id, to_id), confidence desc, lift desc
  ),
  pairs_out as (
    select coalesce(jsonb_agg(x order by x.orders desc), '[]'::jsonb) as list
    from (
      select ia.pname as a_name, ib.pname as b_name, p.orders
      from pair p
      join item ia on ia.pid = p.a_id
      join item ib on ib.pid = p.b_id
      order by p.orders desc, ia.pname
      limit greatest(_limit, 1)
    ) x
  ),
  upsell_out as (
    select coalesce(jsonb_agg(x order by x.lift desc), '[]'::jsonb) as list
    from (
      select from_name, to_name, orders, from_orders,
             round(confidence, 6) as confidence,
             round(lift, 4)       as lift
      from best
      order by lift desc, orders desc
      limit greatest(_limit, 1)
    ) x
  )
  select jsonb_build_object(
    'orders',     (select orders from scope),
    'pairs',      pairs_out.list,
    'pair_count', (select count(*) from pair),
    'upsell',     upsell_out.list,
    'min_orders', greatest(_min_orders, 1)
  )
  into _result
  from pairs_out, upsell_out;

  return _result;
end;
$$;

revoke all on function public.dashboard_basket(uuid, text, date, date, int, int) from public;
revoke all on function public.dashboard_basket(uuid, text, date, date, int, int) from anon;
revoke all on function public.dashboard_basket(uuid, text, date, date, int, int) from authenticated;
grant execute on function public.dashboard_basket(uuid, text, date, date, int, int) to authenticated;
