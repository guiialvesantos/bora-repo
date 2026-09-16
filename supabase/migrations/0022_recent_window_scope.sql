-- A janela recente só existe no modelo de demanda legado.
--
-- `recent_window_days` alimenta `weekly_recent`, e `weekly_recent` só entra em
-- `weekly_blended` no ramo `blended_legacy`. Sob `weighted_90_180` a demanda é
-- 0.7·90d + 0.3·180d e a janela não toca em número nenhum — `weekly_recent`
-- continua sendo gravado no snapshot, mas como coluna de auditoria.
--
-- O alerta "a demanda estimada está pela metade" foi escrito para o achado 1 da
-- planilha, que é um defeito do ramo legado. Disparar ele sob o modelo 90/180 é
-- alarme falso: não há metade nenhuma para faltar. E alarme falso numa tela de
-- saúde de dados custa mais caro do que alerta nenhum, porque ensina a ignorar
-- a tela inteira.
--
-- `demand_model` passa a viajar no relatório para a UI poder rotular o campo em
-- vez de escondê-lo em silêncio.

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
        group by o.channel, i.sold_on, i.sku_norm
      ) i
      group by i.sold_on, i.sku_norm
      having count(*) > 1
    ) d
  ),
  pending as (
    select count(*) as n from public.sales_orders
    where company_id = _company_id and not items_fetched
  ),
  no_price as (
    select count(*) as n from public.products
    where company_id = _company_id and is_active and coalesce(sale_price, 0) = 0
  ),
  window_dead as (
    -- O achado 1, medido: a janela recente não pega venda nenhuma porque a
    -- âncora está à frente do fim da base. Só é defeito onde a janela pesa —
    -- ou seja, no modelo legado.
    select (_p.demand_model = 'blended_legacy'
            and _p.recent_window_anchor = 'today'
            and coalesce(_p.today_override, current_date) - _p.recent_window_days
                > (select max(sold_on) from public.sales_order_items
                   where company_id = _company_id)) as dead
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
      'demand_model', _p.demand_model,
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
