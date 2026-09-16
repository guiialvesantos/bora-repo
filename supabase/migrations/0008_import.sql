-- 0008_import — importação de planilha e saúde dos dados.
--
-- A fase 1 substitui a planilha sem depender de credencial do Olist: os mesmos
-- quatro artefatos que hoje são colados à mão viram upload. O importador não é
-- descartável — a loja física e o em-trânsito podem continuar manuais para
-- sempre, e mesmo depois do conector é ele que resgata um dia de sync quebrado.
--
-- Desenho: o cliente escreve em `import_staging` em pedaços (uma linha por
-- pedaço, com um array de registros dentro), e só então chama `import_apply`,
-- que troca tudo de uma vez. Upload interrompido no meio deixa lixo no staging
-- e NÃO deixa a base pela metade — que é o defeito de escrever direto na tabela
-- final a partir do navegador.

do $$ begin
  create type public.import_kind as enum ('products', 'sales', 'in_transit', 'discontinued', 'sigma');
exception when duplicate_object then null; end $$;

-- De onde veio cada pedaço de dado e quando. É a tabela que a tela de saúde lê;
-- na fase 2 o worker do Olist passa a carimbar as mesmas linhas, e a tela não
-- muda.
create table public.data_sources (
  company_id   uuid not null references public.companies (id) on delete cascade,
  kind         public.import_kind not null,
  provider     text not null default 'import',
  filename     text,
  row_count    integer not null default 0,
  -- A data mais recente presente no arquivo. Diferente de `refreshed_at`: um
  -- arquivo importado hoje pode conter venda só até o mês passado, e é essa
  -- diferença que a tela precisa mostrar.
  covers_until date,
  refreshed_at timestamptz not null default now(),
  refreshed_by uuid references auth.users (id) on delete set null,
  primary key (company_id, kind)
);

create table public.import_staging (
  id         uuid primary key default gen_random_uuid(),
  company_id uuid not null references public.companies (id) on delete cascade,
  batch_id   uuid not null,
  kind       public.import_kind not null,
  seq        integer not null,
  rows       jsonb not null,
  created_at timestamptz not null default now(),
  unique (batch_id, seq)
);

create index import_staging_batch_idx on public.import_staging (company_id, batch_id, seq);

alter table public.data_sources   enable row level security;
alter table public.import_staging enable row level security;

create policy data_sources_select on public.data_sources
  for select to authenticated using (company_id = any (public.my_company_ids()));

create policy import_staging_select on public.import_staging
  for select to authenticated using (company_id = any (public.my_company_ids()));
create policy import_staging_write on public.import_staging
  for all to authenticated
  using (public.has_company_role(company_id, 'owner', 'gestor', 'operador'))
  with check (public.has_company_role(company_id, 'owner', 'gestor', 'operador'));

grant select on public.data_sources to authenticated;
grant select, insert, delete on public.import_staging to authenticated;

-- ---------------------------------------------------------------- apply
--
-- Uma função só para os cinco artefatos. Alternativa seria cinco funções quase
-- idênticas; o `case` aqui é menor do que a duplicação seria, e garante que a
-- troca-e-carimba aconteça do mesmo jeito em todos.

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
    delete from public.discontinued_items where company_id = _company_id;
    insert into public.discontinued_items (company_id, sku, name)
    select _company_id, e ->> 'sku', nullif(e ->> 'name', '')
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
-- Porte da aba `Verificações`, mais o que ela não tinha como ter. A regra de
-- `blocking`: só bloqueia o que faz o pedido de compra sair errado. Aviso que
-- bloqueia tudo ensina a ignorar aviso.

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
    -- âncora está à frente do fim da base.
    select (_p.recent_window_anchor = 'today'
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
