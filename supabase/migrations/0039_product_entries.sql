-- ============================================================================
-- 0039 — Entradas de estoque na ficha do produto
-- ----------------------------------------------------------------------------
-- Não existe nota de entrada na base. O Tiny não manda data de recebimento, o
-- pedido de compra não guarda `received_on`, `qty_received` é zero em todas as
-- linhas e `products.created_at` é a data do sync, não a da primeira caixa que
-- chegou. Perguntar "quando esse produto entrou" para as tabelas de compra não
-- tem resposta.
--
-- Mas `inventory_position_daily` (0015) grava o saldo de cada produto todo dia.
-- Dois dias seguidos de saldo mais a venda do meio fecham a conta:
--
--     entrou(D) ≈ saldo(D) − saldo(D−1) + vendido(D)
--
-- O deslocamento de um dia é obrigatório e não é detalhe: o snapshot roda às
-- 03:40 BRT, então a linha `as_of = D` é a foto do FECHAMENTO de D−1. Por isso
-- o movimento é datado em `as_of - 1` e a venda comparada é a do intervalo
-- `[as_of anterior, as_of - 1]`. Sem isso toda entrada aparece um dia adiantada.
--
-- `span` diz quantos dias o degrau cobre. Normalmente 1; se o snapshot falhou
-- numa noite, vira 2 e a data passa a ser "em algum momento desses dois dias" —
-- a tela precisa saber disso para não afirmar mais precisão do que existe.
--
-- Resultado negativo é saída sem venda (avaria, ajuste de inventário, ou a
-- defasagem entre a data do pedido e o dia em que o Tiny baixou a peça). Fica
-- de fora da lista: aqui só interessa o que entrou.
--
-- `entries_since` é o primeiro dia com foto. Antes dele não há como saber nada,
-- e a tela tem que dizer isso em vez de deixar o usuário achar que um produto
-- antigo nunca recebeu reposição.
-- ============================================================================

create or replace function public.product_analysis(
  _company_id uuid,
  _product_id uuid,
  _days       int default 90
)
returns jsonb
language plpgsql
stable
security definer
set search_path = public, pg_catalog
as $$
declare
  _result     jsonb;
  _from       date;
  _today      date;
  _base_start date;
begin
  if not public.user_can_access_company(_company_id) then
    raise exception 'sem acesso a esta empresa' using errcode = '42501';
  end if;

  -- "Hoje" é a data de venda mais recente da EMPRESA, não `current_date`. O
  -- mesmo motivo da 0022: se o sync parou há três dias, ancorar no calendário
  -- coloca três dias de zero no fim de toda série e faz a demanda despencar
  -- num produto que ninguém mexeu.
  select coalesce(max(sold_on), current_date), min(sold_on)
    into _today, _base_start
  from public.sales_orders where company_id = _company_id and not shadow;

  _from := _today - greatest(_days, 1) + 1;

  with
  prod as (
    select p.*,
           pp.id   as parent_id,
           pp.name as parent_name
    from public.products p
    left join public.products pp
      on pp.company_id = p.company_id
     and pp.external_id = p.parent_external_id
    where p.id = _product_id and p.company_id = _company_id
  ),
  -- O que está sendo medido. Um pai mede os filhos; qualquer outra coisa mede a
  -- si mesma. Uma variação órfã (25 na All Out: `variation_type = 'V'` sem
  -- `parent_external_id`) cai no segundo braço e se comporta como avulsa, que é
  -- o que ela é — não há grade para somar.
  scope as (
    select c.id
    from public.products c, prod
    where c.company_id = _company_id
      and prod.variation_type = 'P'
      and prod.external_id is not null
      and c.parent_external_id = prod.external_id
    union
    select prod.id from prod where coalesce(prod.variation_type, 'N') <> 'P'
  ),
  -- A grade: irmãos do mesmo pai, ou os filhos quando o escolhido É o pai.
  -- Serve para o cartão de grade desbalanceada — estoque parado num tamanho
  -- que não vende não aparece olhando só para a linha escolhida.
  family as (
    select c.id, c.sku, c.name
    from public.products c, prod
    where c.company_id = _company_id
      and (
        (prod.parent_external_id is not null
          and c.parent_external_id = prod.parent_external_id)
        or (prod.variation_type = 'P' and c.parent_external_id = prod.external_id)
      )
  ),
  -- Saldo por produto. `include_in_available` é a MESMA definição do motor:
  -- misturar avaria e defeito aqui faria a ficha discordar do Pedido de compra.
  stock as (
    select ps.product_id, sum(ps.qty) as qty
    from public.product_stock ps
    join public.warehouses w on w.id = ps.warehouse_id
    where ps.company_id = _company_id and w.include_in_available
    group by ps.product_id
  ),
  -- Um pai espalha a grade por vários depósitos; sem o `group by` a lista
  -- traria "Loghouse" trinta e cinco vezes.
  by_wh as (
    select coalesce(jsonb_agg(x.o order by x.qty desc), '[]'::jsonb) as list
    from (
      select w.name, sum(ps.qty) as qty,
             jsonb_build_object(
               'name', w.name, 'qty', sum(ps.qty),
               'available', bool_or(w.include_in_available)
             ) as o
      from public.product_stock ps
      join public.warehouses w on w.id = ps.warehouse_id
      where ps.company_id = _company_id
        and ps.product_id in (select id from scope)
      group by w.name
      having sum(ps.qty) <> 0
    ) x
  ),
  transit as (
    select coalesce(sum(i.qty_open), 0) as qty
    from public.purchase_order_items i
    join public.purchase_orders o on o.id = i.order_id
    where i.company_id = _company_id
      and i.product_id in (select id from scope)
      and o.status in ('open', 'draft')
  ),
  -- Venda do escopo, dia a dia. Só os dias COM venda; a série completa (com os
  -- zeros) é montada no cliente, que já sabe a janela — mandar 180 zeros pela
  -- rede para o navegador redesenhar não paga a viagem.
  sales as (
    select i.sold_on as d, sum(i.qty) as u, sum(i.qty * i.unit_price) as r
    from public.sales_order_items i
    join public.sales_orders o on o.id = i.order_id
    where i.company_id = _company_id
      and i.product_id in (select id from scope)
      and not i.shadow and not o.shadow
      and i.sold_on between _from and _today
    group by i.sold_on
  ),
  daily as (
    select coalesce(jsonb_agg(jsonb_build_object('d', d, 'u', u, 'r', r) order by d), '[]'::jsonb) as list
    from sales
  ),
  life as (
    select min(i.sold_on) as first_sale, max(i.sold_on) as last_sale,
           coalesce(sum(i.qty), 0) as total_units,
           coalesce(sum(i.qty * i.unit_price), 0) as total_revenue
    from public.sales_order_items i
    join public.sales_orders o on o.id = i.order_id
    where i.company_id = _company_id
      and i.product_id in (select id from scope)
      and not i.shadow and not o.shadow
  ),
  -- ------------------------------------------------------------------------
  -- A CURVA DE LANÇAMENTO: semana 1, 2, 3… desde a primeira venda.
  --
  -- Ancorada no INÍCIO (ao contrário dos baldes do gráfico de histórico, que
  -- ancoram no fim). Aqui o início é o fato — a semana 1 tem que ser a semana
  -- 1 —, e a consequência é que a ÚLTIMA semana é que fica pela metade. Por
  -- isso cada semana leva `days`: a tela desenha a incompleta de outro jeito,
  -- senão o gráfico termina sempre numa queda que não aconteceu.
  --
  -- Toda a vida do produto, independente do seletor de período: "como foi a
  -- semana 3" não muda porque alguém escolheu ver 30 dias.
  -- ------------------------------------------------------------------------
  launch as (
    select coalesce(jsonb_agg(jsonb_build_object(
             'week',    wk.n,
             'units',   coalesce(s.u, 0),
             'revenue', coalesce(s.r, 0),
             'days',    least(7, (_today - (l.first_sale + (wk.n - 1) * 7)) + 1)
           ) order by wk.n), '[]'::jsonb) as list
    from life l
    cross join lateral generate_series(
      1, ((_today - l.first_sale) / 7) + 1
    ) as wk(n)
    left join lateral (
      select sum(i.qty) as u, sum(i.qty * i.unit_price) as r
      from public.sales_order_items i
      join public.sales_orders o on o.id = i.order_id
      where i.company_id = _company_id
        and i.product_id in (select id from scope)
        and not i.shadow and not o.shadow
        and i.sold_on >= l.first_sale + (wk.n - 1) * 7
        and i.sold_on <  l.first_sale + wk.n * 7
    ) s on true
    where l.first_sale is not null
  ),
  -- As janelas do painel de giro. Fixas em 7/15/30/60/90 e independentes da
  -- janela do gráfico: servem justamente para comparar ritmos entre si, e uma
  -- delas mudando de tamanho junto com o seletor destruiria a comparação.
  windows as (
    select coalesce(jsonb_agg(jsonb_build_object(
             'days', w.n,
             'units', coalesce(s.u, 0),
             'revenue', coalesce(s.r, 0),
             'days_with_sale', coalesce(s.dws, 0),
             -- Quantos dias da janela o produto realmente existiu para vender.
             -- Sem isso, um lançamento de 10 dias comparado numa janela de 90
             -- parece parado, quando o que houve foi que ele não existia.
             'effective_days', least(w.n, greatest(1, (_today - coalesce(l.first_sale, _today)) + 1))
           ) order by w.n), '[]'::jsonb) as list
    from (values (7), (15), (30), (60), (90)) as w(n)
    cross join life l
    left join lateral (
      select sum(i.qty) as u, sum(i.qty * i.unit_price) as r,
             count(distinct i.sold_on) as dws
      from public.sales_order_items i
      join public.sales_orders o on o.id = i.order_id
      where i.company_id = _company_id
        and i.product_id in (select id from scope)
        and not i.shadow and not o.shadow
        and i.sold_on > _today - w.n and i.sold_on <= _today
    ) s on true
  ),
  -- Preço e custo do escopo. O valor do estoque é somado peça a peça com o
  -- preço de CADA variação; a média só existe para o pai sem preço próprio.
  price as (
    select
      coalesce(sum(coalesce(p.sale_price, 0) * coalesce(st.qty, 0)), 0) as stock_value,
      coalesce(sum(coalesce(p.cmv, 0)        * coalesce(st.qty, 0)), 0) as stock_cost,
      avg(p.sale_price) filter (where coalesce(p.sale_price, 0) > 0) as avg_price,
      avg(p.cmv)        filter (where coalesce(p.cmv, 0) > 0)        as avg_cmv,
      count(*) as n
    from scope s
    join public.products p on p.id = s.id
    left join stock st on st.product_id = s.id
  ),
  siblings as (
    select coalesce(jsonb_agg(jsonb_build_object(
             'id', f.id, 'sku', f.sku, 'name', f.name,
             'stock', coalesce(st.qty, 0),
             'units', coalesce(sv.u, 0)
           ) order by coalesce(sv.u, 0) desc, f.sku), '[]'::jsonb) as list
    from family f
    left join stock st on st.product_id = f.id
    left join lateral (
      select sum(i.qty) as u
      from public.sales_order_items i
      join public.sales_orders o on o.id = i.order_id
      where i.company_id = _company_id and i.product_id = f.id
        and not i.shadow and not o.shadow
        and i.sold_on between _from and _today
    ) sv on true
  ),
  -- ------------------------------------------------------------------------
  -- ENTRADAS. Saldo diário do escopo (a grade soma os filhos, como em tudo
  -- mais aqui), degrau a degrau.
  -- ------------------------------------------------------------------------
  pos as (
    select ipd.as_of, sum(ipd.on_hand) as on_hand
    from public.inventory_position_daily ipd
    where ipd.company_id = _company_id
      and ipd.product_id in (select id from scope)
    group by ipd.as_of
  ),
  pos_step as (
    select as_of, on_hand,
           lag(as_of)   over w as prev_as_of,
           lag(on_hand) over w as prev_on_hand
    from pos window w as (order by as_of)
  ),
  -- O `as_of - 1` é o deslocamento do snapshot das 03:40: a foto de hoje é o
  -- fechamento de ontem. A venda somada é a do mesmo intervalo do degrau.
  moves as (
    select p.as_of - 1 as moved_on,
           (p.as_of - p.prev_as_of) as span_days,
           (p.on_hand - p.prev_on_hand) + coalesce(s.u, 0) as qty_in
    from pos_step p
    left join lateral (
      select sum(i.qty) as u
      from public.sales_order_items i
      join public.sales_orders o on o.id = i.order_id
      where i.company_id = _company_id
        and i.product_id in (select id from scope)
        and not i.shadow and not o.shadow
        and i.sold_on >= p.prev_as_of and i.sold_on <= p.as_of - 1
    ) s on true
    where p.prev_as_of is not null
  ),
  entries as (
    select coalesce(jsonb_agg(jsonb_build_object(
             'd', m.moved_on, 'q', m.qty_in, 'span', m.span_days
           ) order by m.moved_on desc) filter (where m.qty_in > 0), '[]'::jsonb) as list,
           max(m.moved_on) filter (where m.qty_in > 0) as last_entry,
           coalesce(sum(m.qty_in) filter (where m.qty_in > 0), 0) as total_in
    from moves m
  ),
  coverage as (select min(as_of) as since from pos)
  select jsonb_build_object(
    'today', _today,
    'from', _from,
    'days', greatest(_days, 1),
    'product', jsonb_build_object(
      'id', prod.id, 'sku', prod.sku, 'name', prod.name,
      'image_url', prod.image_url,
      'sale_price', coalesce(nullif(prod.sale_price, 0), price.avg_price),
      'cmv',        coalesce(nullif(prod.cmv, 0),        price.avg_cmv),
      'category', prod.category, 'brand', prod.brand,
      'tags', prod.tags, 'is_active', prod.is_active,
      'variation_type', prod.variation_type,
      'parent_id', prod.parent_id, 'parent_name', prod.parent_name,
      'created_at', prod.created_at
    ),
    -- `is_grade` diz que os números abaixo são de um CONJUNTO. Sem isso a tela
    -- escreveria "0,77 un/dia" para a grade e para o tamanho M do mesmo jeito,
    -- e são duas afirmações diferentes.
    'is_grade',   coalesce(prod.variation_type = 'P', false),
    'scope_size', price.n,
    'stock',      (select coalesce(sum(st.qty), 0) from stock st where st.product_id in (select id from scope)),
    'stock_value', price.stock_value,
    'stock_cost',  price.stock_cost,
    'warehouses', by_wh.list,
    'in_transit', (select qty from transit),
    'daily',      daily.list,
    'windows',    windows.list,
    'launch',     launch.list,
    -- Verdadeiro quando a primeira venda está colada no começo da base: o
    -- produto provavelmente já vendia antes do dado existir, e a semana 1 é o
    -- começo do arquivo, não o lançamento.
    'launch_censored', coalesce(life.first_sale <= _base_start + 7, false),
    'base_start', _base_start,
    'siblings',   siblings.list,
    'first_sale', life.first_sale,
    'last_sale',  life.last_sale,
    'total_units', life.total_units,
    'total_revenue', life.total_revenue,
    -- Entradas: data + quantidade. `entries_since` marca onde a série começa —
    -- antes dela não há foto, e silêncio não é "não entrou nada".
    'entries',       entries.list,
    'entries_since', (select since from coverage),
    'last_entry',    entries.last_entry,
    'entries_total', entries.total_in
  )
  into _result
  from prod, by_wh, daily, windows, launch, siblings, life, price, entries;

  return _result;
end;
$$;

revoke all on function public.product_analysis(uuid, uuid, int) from public;
revoke all on function public.product_analysis(uuid, uuid, int) from anon;
revoke all on function public.product_analysis(uuid, uuid, int) from authenticated;
grant execute on function public.product_analysis(uuid, uuid, int) to authenticated;
