-- 0003_sales — pedidos de venda e seus itens.

do $$ begin
  create type public.sales_channel as enum ('olist', 'site', 'loja', 'manual');
exception when duplicate_object then null; end $$;

create table public.sales_orders (
  id            uuid primary key default gen_random_uuid(),
  company_id    uuid not null references public.companies (id) on delete cascade,
  external_id   text,
  channel       public.sales_channel not null default 'manual',
  number        text,
  status        text,
  ordered_at    timestamptz not null,
  -- A data de venda materializada no fuso da empresa. `at time zone` é STABLE,
  -- não IMMUTABLE: sem materializar não dá para indexar, e o bucket semanal de
  -- 7 dias escorregaria uma hora no horário de verão — o que muda de bucket
  -- as vendas feitas perto da meia-noite e, por tabela, o desvio-padrão.
  sold_on       date not null,
  -- Só existe quando os itens já foram buscados. Na API v2 do Tiny o list de
  -- pedidos não traz item nenhum: é um GET por pedido. Este booleano é o que
  -- separa "não vendeu nada" de "ainda não perguntei".
  items_fetched boolean not null default false,
  created_at    timestamptz not null default now(),
  unique (company_id, channel, external_id)
);

create index sales_orders_company_date_idx on public.sales_orders (company_id, sold_on);
create index sales_orders_pending_items_idx on public.sales_orders (company_id)
  where items_fetched = false;

create table public.sales_order_items (
  id          uuid primary key default gen_random_uuid(),
  company_id  uuid not null references public.companies (id) on delete cascade,
  order_id    uuid not null references public.sales_orders (id) on delete cascade,
  product_id  uuid references public.products (id) on delete set null,
  -- O SKU cru fica gravado mesmo quando casa com um produto. Venda de item que
  -- saiu do catálogo continua sendo demanda, e é isso que alimenta a tela de
  -- saúde dos dados ("venda sem produto casado").
  sku         text,
  sku_norm    text generated always as (nullif(upper(btrim(sku)), '')) stored,
  -- Ver `products.sku_upper`: o SUMIF da planilha ignora a caixa mas não apara
  -- espaço. Hoje os SKUs de venda estão limpos e as duas colunas coincidem, mas
  -- o motor casa pelos dois lados da mesma chave — sem esta coluna, o modo
  -- legado compararia `upper(sku)` do produto com `sku_norm` da venda.
  sku_upper   text generated always as (nullif(upper(sku), '')) stored,
  qty         numeric(14, 4) not null default 0,
  unit_price  numeric(14, 4),
  sold_on     date not null,
  created_at  timestamptz not null default now()
);

create index sales_order_items_company_date_idx on public.sales_order_items (company_id, sold_on);
create index sales_order_items_product_idx on public.sales_order_items (product_id, sold_on);
create index sales_order_items_sku_idx on public.sales_order_items (company_id, sku_norm);
create index sales_order_items_sku_upper_idx on public.sales_order_items (company_id, sku_upper);
create index sales_order_items_order_idx on public.sales_order_items (order_id);

alter table public.sales_orders      enable row level security;
alter table public.sales_order_items enable row level security;

create policy sales_orders_select on public.sales_orders
  for select to authenticated using (company_id = any (public.my_company_ids()));
create policy sales_orders_write on public.sales_orders
  for all to authenticated
  using (public.has_company_role(company_id, 'owner', 'gestor', 'operador'))
  with check (public.has_company_role(company_id, 'owner', 'gestor', 'operador'));

create policy sales_order_items_select on public.sales_order_items
  for select to authenticated using (company_id = any (public.my_company_ids()));
create policy sales_order_items_write on public.sales_order_items
  for all to authenticated
  using (public.has_company_role(company_id, 'owner', 'gestor', 'operador'))
  with check (public.has_company_role(company_id, 'owner', 'gestor', 'operador'));

grant select, insert, update, delete on public.sales_orders      to authenticated;
grant select, insert, update, delete on public.sales_order_items to authenticated;
