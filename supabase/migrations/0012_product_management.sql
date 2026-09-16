-- 0012_product_management — fora de coleção gerenciado no app, sem planilha.
--
-- `discontinued_items` continua sendo a fonte de verdade do motor (a paridade
-- não muda de caminho): o que muda é COMO as linhas entram. Cada linha ganha
-- `source` — 'import' (veio do arquivo) ou 'manual' (marcada na tela Produtos).
-- O importador passa a substituir SÓ as linhas dele; marcação manual sobrevive
-- a qualquer upload. E um trigger carimba `data_sources` a cada edição manual,
-- para a tela de saúde saber que o dado está vivo — fonte gerida no app
-- ('app') nunca fica "desatualizada", porque não existe arquivo para vencer.

-- ---------------------------------------------------------------- coluna

alter table public.discontinued_items
  add column source     text not null default 'import'
    check (source in ('import', 'manual')),
  add column created_by uuid references auth.users (id) on delete set null;

-- ---------------------------------------------------------------- trigger
--
-- Statement-level com transition table: o import troca ~1000 linhas numa
-- tacada, e um trigger por linha faria 1000 upserts no mesmo registro de
-- data_sources. SECURITY DEFINER porque `authenticated` não tem (nem deve
-- ganhar) INSERT em data_sources — o carimbo é efeito colateral do sistema,
-- não escrita do usuário.
--
-- Durante o import o trigger também dispara e carimba 'app', mas o
-- `import_apply` faz o upsert dele DEPOIS do branch de discontinued, então
-- 'import' vence — o carimbo 'app' só sobrevive quando a edição veio da tela.

create or replace function public.discontinued_items_stamp()
returns trigger
language plpgsql
security definer
set search_path = public, pg_catalog
as $$
declare
  _company uuid;
begin
  if tg_op = 'DELETE' then
    select company_id into _company from old_rows limit 1;
  else
    select company_id into _company from new_rows limit 1;
  end if;
  if _company is null then
    return null; -- statement sem linhas (delete que não achou nada)
  end if;

  insert into public.data_sources (company_id, kind, provider, filename, row_count,
                                   covers_until, refreshed_at, refreshed_by)
  values (_company, 'discontinued', 'app', null,
          (select count(*) from public.discontinued_items where company_id = _company),
          null, now(), auth.uid())
  on conflict (company_id, kind) do update set
    provider = 'app', filename = null, row_count = excluded.row_count,
    covers_until = null, refreshed_at = now(), refreshed_by = auth.uid();
  return null;
end;
$$;

revoke all on function public.discontinued_items_stamp() from public;
revoke all on function public.discontinued_items_stamp() from anon;
revoke all on function public.discontinued_items_stamp() from authenticated;

create trigger discontinued_items_stamp_ins
  after insert on public.discontinued_items
  referencing new table as new_rows
  for each statement execute function public.discontinued_items_stamp();

create trigger discontinued_items_stamp_del
  after delete on public.discontinued_items
  referencing old table as old_rows
  for each statement execute function public.discontinued_items_stamp();

-- ---------------------------------------------------------------- import_apply
--
-- Mesmo corpo da 0008, com UMA mudança: o branch de `discontinued` apaga só
-- `source = 'import'` e insere com `source = 'import'`. O `on conflict do
-- nothing` faz a linha manual vencer quando o mesmo SKU aparece no arquivo —
-- a marcação da tela é a mais recente e deliberada das duas.

create or replace function public.import_apply(
  _company_id uuid,
  _batch_id uuid,
  _kind public.import_kind,
  _filename text default null
)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_catalog
as $$
declare
  _rows     jsonb;
  _count    integer := 0;
  _covers   date;
  _wh       uuid;
begin
  if not public.has_company_role(_company_id, 'owner', 'gestor', 'operador') then
    raise exception 'sem permissão para importar nesta empresa' using errcode = '42501';
  end if;

  select coalesce(jsonb_agg(e), '[]'::jsonb) into _rows
  from public.import_staging s, jsonb_array_elements(s.rows) as e
  where s.company_id = _company_id and s.batch_id = _batch_id and s.kind = _kind;

  if jsonb_array_length(_rows) = 0 then
    raise exception 'lote % está vazio para %', _batch_id, _kind using errcode = 'P0002';
  end if;

  if _kind = 'products' then
    -- Depósito único enquanto a origem é planilha: o arquivo de estoque traz um
    -- total consolidado, e inventar dois depósitos a partir dele seria inventar
    -- dado. Na fase 2 o Olist traz o split de verdade e este vira mais um.
    insert into public.warehouses (company_id, external_id, name)
    values (_company_id, 'import', 'Importado')
    on conflict (company_id, external_id) do update set name = excluded.name
    returning id into _wh;

    insert into public.products (company_id, external_id, sku, name, sale_price, cmv, source_row, is_active)
    select _company_id,
           coalesce(nullif(e ->> 'external_id', ''), 'imp-' || (e ->> 'sku')),
           e ->> 'sku', e ->> 'name',
           coalesce((e ->> 'sale_price')::numeric, 0),
           nullif(e ->> 'cmv', '')::numeric,
           (e ->> 'source_row')::integer,
           true
    from jsonb_array_elements(_rows) as e
    on conflict (company_id, external_id) do update set
      sku = excluded.sku, name = excluded.name, sale_price = excluded.sale_price,
      cmv = excluded.cmv, source_row = excluded.source_row, is_active = true;

    -- Produto que sumiu do arquivo não é apagado: vira inativo. Apagar levaria
    -- junto o histórico de venda dele por cascata, e demanda passada continua
    -- sendo demanda.
    update public.products p set is_active = false
    where p.company_id = _company_id
      and p.is_active
      and not exists (
        select 1 from jsonb_array_elements(_rows) as e
        where coalesce(nullif(e ->> 'external_id', ''), 'imp-' || (e ->> 'sku')) = p.external_id
      );

    insert into public.product_stock (product_id, warehouse_id, company_id, qty)
    select p.id, _wh, _company_id, coalesce((e ->> 'stock_total')::numeric, 0)
    from jsonb_array_elements(_rows) as e
    join public.products p
      on p.company_id = _company_id
     and p.external_id = coalesce(nullif(e ->> 'external_id', ''), 'imp-' || (e ->> 'sku'))
    on conflict (product_id, warehouse_id) do update
      set qty = excluded.qty, updated_at = now();

  elsif _kind = 'sales' then
    -- Substituição total. Venda importada é um retrato do arquivo inteiro; o
    -- incremental é trabalho do conector, não do upload.
    delete from public.sales_orders where company_id = _company_id and channel = 'manual';

    insert into public.sales_orders (company_id, channel, external_id, ordered_at, sold_on, items_fetched)
    select _company_id, 'manual', 'imp-' || d::text, d + time '12:00', d, true
    from (select distinct (e ->> 'sold_on')::date as d from jsonb_array_elements(_rows) as e) x
    on conflict (company_id, channel, external_id) do nothing;

    insert into public.sales_order_items (company_id, order_id, sku, qty, unit_price, sold_on)
    select _company_id, o.id, e ->> 'sku',
           coalesce((e ->> 'qty')::numeric, 0),
           nullif(e ->> 'unit_price', '')::numeric,
           (e ->> 'sold_on')::date
    from jsonb_array_elements(_rows) as e
    join public.sales_orders o
      on o.company_id = _company_id and o.channel = 'manual'
     and o.external_id = 'imp-' || (e ->> 'sold_on');

    update public.sales_order_items i set product_id = p.id
    from public.products p
    where i.company_id = _company_id and p.company_id = _company_id
      and p.sku_norm = i.sku_norm and i.product_id is null;

    select max((e ->> 'sold_on')::date) into _covers from jsonb_array_elements(_rows) as e;

  elsif _kind = 'in_transit' then
    delete from public.purchase_orders
    where company_id = _company_id and source = 'import';

    insert into public.purchase_orders (company_id, external_id, source, status, ordered_on)
    values (_company_id, 'planilha', 'import', 'open', current_date);

    insert into public.purchase_order_items (company_id, order_id, sku, qty_ordered, eta_on, category)
    select _company_id, po.id, e ->> 'sku',
           coalesce((e ->> 'qty')::numeric, 0),
           nullif(e ->> 'eta', '')::date,
           nullif(e ->> 'category', '')
    from jsonb_array_elements(_rows) as e
    cross join (select id from public.purchase_orders
                where company_id = _company_id and source = 'import' limit 1) po;

    update public.purchase_order_items i set product_id = p.id
    from public.products p
    where i.company_id = _company_id and p.company_id = _company_id
      and p.sku_norm = i.sku_norm and i.product_id is null;

    select max(nullif(e ->> 'eta', '')::date) into _covers from jsonb_array_elements(_rows) as e;

  elsif _kind = 'discontinued' then
    -- Substitui só o que veio de arquivo; marcação manual da tela Produtos
    -- sobrevive ao upload. Em conflito de SKU a linha manual vence.
    delete from public.discontinued_items
    where company_id = _company_id and source = 'import';

    insert into public.discontinued_items (company_id, sku, name, source)
    select _company_id, e ->> 'sku', nullif(e ->> 'name', ''), 'import'
    from jsonb_array_elements(_rows) as e
    where nullif(e ->> 'sku', '') is not null
    on conflict (company_id, sku) do nothing;

  elsif _kind = 'sigma' then
    delete from public.external_sigma where company_id = _company_id;
    insert into public.external_sigma (company_id, sku, sigma, source)
    select _company_id, e ->> 'sku', coalesce((e ->> 'sigma')::numeric, 0), _filename
    from jsonb_array_elements(_rows) as e
    where nullif(e ->> 'sku', '') is not null
    on conflict (company_id, sku) do nothing;
  end if;

  _count := jsonb_array_length(_rows);

  insert into public.data_sources (company_id, kind, provider, filename, row_count,
                                   covers_until, refreshed_at, refreshed_by)
  values (_company_id, _kind, 'import', _filename, _count, _covers, now(), auth.uid())
  on conflict (company_id, kind) do update set
    provider = 'import', filename = excluded.filename, row_count = excluded.row_count,
    covers_until = excluded.covers_until, refreshed_at = now(), refreshed_by = auth.uid();

  delete from public.import_staging
  where company_id = _company_id and batch_id = _batch_id and kind = _kind;

  return jsonb_build_object('kind', _kind, 'rows', _count, 'covers_until', _covers);
end;
$$;

revoke all on function public.import_apply(uuid, uuid, public.import_kind, text) from public;
revoke all on function public.import_apply(uuid, uuid, public.import_kind, text) from anon;
revoke all on function public.import_apply(uuid, uuid, public.import_kind, text) from authenticated;
grant execute on function public.import_apply(uuid, uuid, public.import_kind, text) to authenticated;

-- ---------------------------------------------------------------- saúde
--
-- Mesmo corpo da 0011 (com os `not shadow`), com UMA mudança: fonte com
-- provider = 'app' nunca é "desatualizada". A regra dos 7 dias existe para
-- arquivo que alguém esquece de reenviar; dado gerido dentro do app está
-- sempre atual por definição — acusar staleness aqui ensinaria a ignorar o
-- banner.

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
    -- passada ainda decide, dado de duas semanas atrás já não. Fonte 'app' é
    -- gerida dentro do sistema — não tem arquivo para vencer, nunca é velha.
    'stale', d.refreshed_at is null
             or (d.provider <> 'app' and d.refreshed_at < now() - interval '7 days'),
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
