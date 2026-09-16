-- 0033_dashboard_categories — venda por categoria, em dois níveis.
--
-- A categoria do Tiny v3 é um CAMINHO, não um rótulo:
--
--     "Feminino -> Bottom -> Bermuda"
--
-- Achatar isso numa lista só de folhas daria 34 linhas de cauda longa e
-- esconderia a única leitura que muda decisão de compra: quanto do faturamento
-- é feminino, quanto é masculino, quanto é acessório. Mostrar só o primeiro
-- nível daria três barras e nenhuma ação. Por isso os dois: o primeiro nível
-- fecha o total, e cada um abre no resto do caminho.
--
-- O filho é o RESTO do caminho, não a folha. "Feminino -> Upper -> Casual" e
-- "Feminino -> Bottom -> Casual" são duas coisas diferentes que virariam a
-- mesma linha chamada "Casual".
--
-- Obedece a canal e período, NUNCA a depósito — é relatório de venda, e o
-- pedido não guarda de qual prateleira a peça saiu (mesma regra da 0030/0031).
--
-- ---------------------------------------------------------------------------
-- O QUE SAI SEPARADO, E POR QUÊ: venda sem categoria.
--
-- 155 produtos da All Out e os 378 da Triana estão com `category` nula. Somar
-- essa venda dentro de "Outros" faria a soma das categorias fechar com o
-- faturamento e mentir sobre a cobertura do catálogo; deixar de fora sem dizer
-- faria as barras somarem menos que o total sem explicação. Então vai num
-- campo próprio, para a tela poder dizer a frase certa.
-- ---------------------------------------------------------------------------

create or replace function public.dashboard_sales_by_category(
  _company_id uuid,
  _channel    text default null,
  _from       date default null,
  _to         date default null
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
  sold as (
    select p.category,
           sum(i.qty)                 as units,
           sum(i.qty * i.unit_price)  as revenue
    from public.sales_order_items i
    join public.sales_orders o on o.id = i.order_id
    join public.products p on p.id = i.product_id
    where i.company_id = _company_id
      and not i.shadow and not o.shadow
      and (_channel is null or o.channel::text = _channel)
      and (_from is null or i.sold_on >= _from)
      and (_to   is null or i.sold_on <= _to)
    group by p.category
  ),
  split as (
    select
      btrim(split_part(s.category, '->', 1)) as top,
      -- Tudo depois do primeiro `->`. `nullif` porque um produto categorizado
      -- só no primeiro nível ("Acessórios") não tem filho — e uma string vazia
      -- desenharia uma linha filha sem nome.
      nullif(btrim(substr(s.category, position('->' in s.category) + 2)), '') as rest,
      s.units, s.revenue
    from sold s
    where s.category is not null and btrim(s.category) <> ''
  ),
  -- O resto do caminho normalizado: o ERP escreve ora "A -> B", ora "A->B", e
  -- os dois são a mesma prateleira.
  child as (
    select top,
           case when rest is null then null
                else btrim(regexp_replace(rest, '\s*->\s*', ' → ', 'g')) end as label,
           sum(units) as units, sum(revenue) as revenue
    from split
    group by 1, 2
  ),
  parent as (
    select top, sum(units) as units, sum(revenue) as revenue
    from child group by top
  ),
  tree as (
    select coalesce(jsonb_agg(jsonb_build_object(
             'name', p.top,
             'units', p.units,
             'revenue', p.revenue,
             'children', coalesce(c.list, '[]'::jsonb)
           ) order by p.revenue desc, p.top), '[]'::jsonb) as list
    from parent p
    left join lateral (
      select jsonb_agg(jsonb_build_object(
               'name', ch.label, 'units', ch.units, 'revenue', ch.revenue
             ) order by ch.revenue desc, ch.label) as list
      from child ch
      where ch.top = p.top and ch.label is not null
    ) c on true
  ),
  none as (
    select coalesce(sum(units), 0) as units, coalesce(sum(revenue), 0) as revenue
    from sold where category is null or btrim(category) = ''
  )
  select jsonb_build_object(
    'categories', tree.list,
    'total_units',   (select coalesce(sum(units), 0)   from parent),
    'total_revenue', (select coalesce(sum(revenue), 0) from parent),
    'uncategorized_units',   none.units,
    'uncategorized_revenue', none.revenue,
    -- Falso na empresa cujo catálogo não categoriza nada (a Triana). Vazio por
    -- falta de DADO ≠ vazio por falta de venda, e a tela precisa saber qual
    -- dos dois está olhando.
    'has_categories', exists (
      select 1 from public.products
      where company_id = _company_id and category is not null and btrim(category) <> ''
    )
  )
  into _result
  from tree, none;

  return _result;
end;
$$;

revoke all on function public.dashboard_sales_by_category(uuid, text, date, date) from public;
revoke all on function public.dashboard_sales_by_category(uuid, text, date, date) from anon;
revoke all on function public.dashboard_sales_by_category(uuid, text, date, date) from authenticated;
grant execute on function public.dashboard_sales_by_category(uuid, text, date, date) to authenticated;
