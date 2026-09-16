-- 0004_purchasing — pedidos de compra / produção. É daqui que sai o "em trânsito".
--
-- Hoje o em-trânsito entra por importação de planilha. O módulo de produção
-- (fase 4) vai gravar nas MESMAS tabelas, então o motor nunca precisa saber de
-- onde a peça veio: ele lê `qty_open` e pronto.

do $$ begin
  create type public.purchase_status as enum ('draft', 'open', 'received', 'cancelled');
exception when duplicate_object then null; end $$;

create table public.purchase_orders (
  id          uuid primary key default gen_random_uuid(),
  company_id  uuid not null references public.companies (id) on delete cascade,
  external_id text,
  source      text not null default 'manual',
  status      public.purchase_status not null default 'open',
  supplier    text,
  ordered_on  date,
  eta_on      date,
  note        text,
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now(),
  unique (company_id, source, external_id)
);

create table public.purchase_order_items (
  id           uuid primary key default gen_random_uuid(),
  company_id   uuid not null references public.companies (id) on delete cascade,
  order_id     uuid not null references public.purchase_orders (id) on delete cascade,
  product_id   uuid references public.products (id) on delete set null,
  sku          text,
  sku_norm     text generated always as (nullif(upper(btrim(sku)), '')) stored,
  -- Ver `products.sku_upper`: é por esta coluna que o motor casa em modo legado.
  -- A planilha perde 757 peças em trânsito por causa disso — é a divergência 4.
  sku_upper    text generated always as (nullif(upper(sku), '')) stored,
  qty_ordered  numeric(14, 4) not null default 0,
  qty_received numeric(14, 4) not null default 0,
  -- `greatest(...,0)` porque recebimento a mais acontece e não pode virar
  -- trânsito negativo, que abateria estoque que existe de verdade.
  qty_open     numeric(14, 4)
                 generated always as (greatest(qty_ordered - qty_received, 0)) stored,
  eta_on       date,
  category     text,
  created_at   timestamptz not null default now()
);

create index purchase_order_items_company_sku_idx
  on public.purchase_order_items (company_id, sku_norm);
create index purchase_order_items_company_sku_upper_idx
  on public.purchase_order_items (company_id, sku_upper);
create index purchase_order_items_product_idx on public.purchase_order_items (product_id);
create index purchase_order_items_order_idx on public.purchase_order_items (order_id);

create trigger purchase_orders_updated_at before update on public.purchase_orders
  for each row execute function public.set_updated_at();

alter table public.purchase_orders      enable row level security;
alter table public.purchase_order_items enable row level security;

create policy purchase_orders_select on public.purchase_orders
  for select to authenticated using (company_id = any (public.my_company_ids()));
create policy purchase_orders_write on public.purchase_orders
  for all to authenticated
  using (public.has_company_role(company_id, 'owner', 'gestor', 'operador'))
  with check (public.has_company_role(company_id, 'owner', 'gestor', 'operador'));

create policy purchase_order_items_select on public.purchase_order_items
  for select to authenticated using (company_id = any (public.my_company_ids()));
create policy purchase_order_items_write on public.purchase_order_items
  for all to authenticated
  using (public.has_company_role(company_id, 'owner', 'gestor', 'operador'))
  with check (public.has_company_role(company_id, 'owner', 'gestor', 'operador'));

grant select, insert, update, delete on public.purchase_orders      to authenticated;
grant select, insert, update, delete on public.purchase_order_items to authenticated;
