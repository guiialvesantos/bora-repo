-- 0015_inventory_position — foto diária da posição de estoque por produto.
--
-- Complementa `stockout_periods` (0014): o trigger dá a transição exata da
-- ruptura; esta tabela dá a POSIÇÃO — a série que futuras análises (censura
-- de demanda, simulação da política de compra, giro) precisam e que não é
-- reconstruível depois. Por isso ela nasce antes de qualquer consumidor:
-- cada dia sem coletar é um dia perdido para sempre.
--
-- Componentes separados, não o resultado: hoje "posição" = available +
-- in_transit, mas se a política mudar (reservado? bloqueado?), o dado bruto
-- ainda permite recalcular o passado. Só se gravam componentes que EXISTEM
-- no sistema — nada de coluna sempre-zero especulativa.

create table public.inventory_position_daily (
  company_id uuid not null references public.companies (id) on delete cascade,
  product_id uuid not null references public.products (id) on delete cascade,
  as_of      date not null,
  -- Soma de TODOS os depósitos, inclusive os fora do disponível (avaria,
  -- devolução…). É o físico total.
  on_hand    numeric(14, 4) not null default 0,
  -- Só depósitos `include_in_available` — a MESMA definição do motor (0007,
  -- CTE `base`) e do trigger de ruptura (0014).
  available  numeric(14, 4) not null default 0,
  -- qty_open de pedidos de compra open/draft — a definição do CTE `transit`.
  in_transit numeric(14, 4) not null default 0,
  created_at timestamptz not null default now(),
  primary key (company_id, product_id, as_of)
);

create index inventory_position_daily_product_idx
  on public.inventory_position_daily (product_id, as_of);

alter table public.inventory_position_daily enable row level security;

create policy inventory_position_daily_select on public.inventory_position_daily
  for select to authenticated
  using (company_id = any (public.my_company_ids()));

-- Escrita só pela função abaixo (e service_role): foto histórica editável à
-- mão deixaria de ser evidência.
grant select on public.inventory_position_daily to authenticated;
grant select, insert, update on public.inventory_position_daily to service_role;

create or replace function public.snapshot_inventory_position()
returns void
language plpgsql
security definer
set search_path = public, pg_catalog
as $$
begin
  -- Upsert por (company, product, dia): rodar duas vezes no mesmo dia
  -- sobrescreve com a foto mais recente em vez de duplicar ou falhar.
  insert into public.inventory_position_daily
    (company_id, product_id, as_of, on_hand, available, in_transit)
  select
    p.company_id,
    p.id,
    current_date,
    coalesce((select sum(ps.qty) from public.product_stock ps
              where ps.product_id = p.id), 0),
    coalesce((select sum(ps.qty) from public.product_stock ps
              join public.warehouses w on w.id = ps.warehouse_id
              where ps.product_id = p.id and w.include_in_available), 0),
    -- Casamento por sku_norm (o modo de produção desde a virada v2). SKU nulo
    -- não casa com nada — sem isso dois nulos casariam entre si.
    coalesce((select sum(poi.qty_open)
              from public.purchase_order_items poi
              join public.purchase_orders po on po.id = poi.order_id
              where po.status in ('open', 'draft')
                and poi.company_id = p.company_id
                and p.sku_norm is not null
                and poi.sku_norm = p.sku_norm), 0)
  from public.products p
  where p.is_active
  on conflict (company_id, product_id, as_of) do update
    set on_hand = excluded.on_hand,
        available = excluded.available,
        in_transit = excluded.in_transit;
end;
$$;

revoke all on function public.snapshot_inventory_position() from public;
revoke all on function public.snapshot_inventory_position() from anon;
revoke all on function public.snapshot_inventory_position() from authenticated;

-- Foto de hoje, agora — a coleta começa no deploy, não amanhã.
select public.snapshot_inventory_position();

-- 06:40 UTC = 03:40 BRT, logo após a reconciliação de rupturas (06:30).
select cron.schedule('inventory-position-daily', '40 6 * * *',
  $$select public.snapshot_inventory_position()$$);
