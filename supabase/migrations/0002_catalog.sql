-- 0002_catalog — depósitos, produtos e estoque por depósito.

create table public.warehouses (
  id                   uuid primary key default gen_random_uuid(),
  company_id           uuid not null references public.companies (id) on delete cascade,
  external_id          text,
  name                 text not null,
  -- Nem todo depósito do Olist conta como estoque disponível: devolução,
  -- avaria e consignação não podem entrar no `E` do cálculo.
  include_in_available boolean not null default true,
  created_at           timestamptz not null default now(),
  updated_at           timestamptz not null default now(),
  unique (company_id, external_id)
);

create table public.products (
  id          uuid primary key default gen_random_uuid(),
  company_id  uuid not null references public.companies (id) on delete cascade,
  -- id do produto no Olist. É a PK real do lado de lá: o `codigo` (SKU) é
  -- opcional e pode repetir.
  external_id text,
  sku         text,
  -- Toda junção por SKU passa por aqui. As referências em trânsito vêm do
  -- fornecedor com espaço sobrando (`'C03CL51O  '`) e casariam com nada.
  sku_norm    text generated always as (nullif(upper(btrim(sku)), '')) stored,
  -- Só maiúsculas, sem aparar. Reproduz o SUMIF/COUNTIF do Excel, que ignora
  -- a caixa mas NÃO ignora espaço. Usada quando `sku_match_mode = 'exact'`.
  sku_upper   text generated always as (nullif(upper(sku), '')) stored,
  name        text,
  sale_price  numeric(14, 4) not null default 0,
  -- CMV informado pela origem. Zero/nulo significa "não informado" — quem
  -- decide o valor usado é o motor (coluna I da planilha), não esta coluna.
  cmv         numeric(14, 4),
  -- Posição do item no arquivo de origem. É o desempate do `SORTBY` da curva
  -- ABC, que no Excel é estável: com dois itens de mesmo faturamento semanal,
  -- fica na frente quem veio antes na planilha.
  source_row  integer,
  is_active   boolean not null default true,
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now(),
  unique (company_id, external_id)
);

create index products_company_sku_idx on public.products (company_id, sku_norm);

create table public.product_stock (
  product_id   uuid not null references public.products (id) on delete cascade,
  warehouse_id uuid not null references public.warehouses (id) on delete cascade,
  company_id   uuid not null references public.companies (id) on delete cascade,
  qty          numeric(14, 4) not null default 0,
  updated_at   timestamptz not null default now(),
  primary key (product_id, warehouse_id)
);

create index product_stock_company_idx on public.product_stock (company_id);

-- Itens fora de coleção. A planilha guarda isso numa lista à parte, não numa
-- flag do produto, porque a lista tem 968 códigos e a maioria nem existe mais
-- no estoque — importar como tabela própria preserva isso.
create table public.discontinued_items (
  company_id uuid not null references public.companies (id) on delete cascade,
  sku        text not null,
  sku_norm   text generated always as (upper(btrim(sku))) stored,
  sku_upper  text generated always as (upper(sku)) stored,
  name       text,
  created_at timestamptz not null default now(),
  primary key (company_id, sku)
);

create index discontinued_items_norm_idx on public.discontinued_items (company_id, sku_norm);
create index discontinued_items_upper_idx on public.discontinued_items (company_id, sku_upper);

create trigger warehouses_updated_at before update on public.warehouses
  for each row execute function public.set_updated_at();
create trigger products_updated_at before update on public.products
  for each row execute function public.set_updated_at();

-- ---------------------------------------------------------------- RLS

alter table public.warehouses         enable row level security;
alter table public.products           enable row level security;
alter table public.product_stock      enable row level security;
alter table public.discontinued_items enable row level security;

create policy warehouses_select on public.warehouses
  for select to authenticated using (company_id = any (public.my_company_ids()));
create policy warehouses_write on public.warehouses
  for all to authenticated
  using (public.has_company_role(company_id, 'owner', 'gestor', 'operador'))
  with check (public.has_company_role(company_id, 'owner', 'gestor', 'operador'));

create policy products_select on public.products
  for select to authenticated using (company_id = any (public.my_company_ids()));
create policy products_write on public.products
  for all to authenticated
  using (public.has_company_role(company_id, 'owner', 'gestor', 'operador'))
  with check (public.has_company_role(company_id, 'owner', 'gestor', 'operador'));

create policy product_stock_select on public.product_stock
  for select to authenticated using (company_id = any (public.my_company_ids()));
create policy product_stock_write on public.product_stock
  for all to authenticated
  using (public.has_company_role(company_id, 'owner', 'gestor', 'operador'))
  with check (public.has_company_role(company_id, 'owner', 'gestor', 'operador'));

create policy discontinued_items_select on public.discontinued_items
  for select to authenticated using (company_id = any (public.my_company_ids()));
create policy discontinued_items_write on public.discontinued_items
  for all to authenticated
  using (public.has_company_role(company_id, 'owner', 'gestor', 'operador'))
  with check (public.has_company_role(company_id, 'owner', 'gestor', 'operador'));

grant select, insert, update, delete on public.warehouses         to authenticated;
grant select, insert, update, delete on public.products           to authenticated;
grant select, insert, update, delete on public.product_stock      to authenticated;
grant select, insert, update, delete on public.discontinued_items to authenticated;
