-- Fecha o laço do em-trânsito.
--
-- Até aqui a tela de pedido era uma sugestão eterna com botão de CSV: ninguém
-- gravava nada. Só que o motor desconta `in_transit` da sugestão, e
-- `in_transit` sai de `purchase_order_items` de pedidos `draft`/`open`. Sem
-- gravar o pedido, a compra acontece fora do sistema e na semana seguinte o
-- motor sugere comprar de novo o que já está a caminho. O laço fica aberto
-- exatamente no ponto que custa dinheiro.
--
-- O pedido nasce `draft` — e `draft` JÁ conta como trânsito. É deliberado: a
-- intenção de comprar é o que precisa suprimir a re-sugestão, não o
-- recebimento. O preço disso é que um rascunho abandonado suprime para sempre,
-- então cancelar tem que ser fácil na UI (status `cancelled` sai do trânsito).

alter table public.purchase_orders
  add column if not exists snapshot_id uuid
    references public.replenishment_snapshots (id) on delete set null,
  add column if not exists params_version integer,
  add column if not exists created_by uuid references auth.users (id) on delete set null;

-- `qty_suggested` guarda o que o motor mandou, ao lado do que a pessoa pediu.
-- É a evidência de quando o humano discordou da máquina — e a única forma de
-- descobrir, seis meses depois, se ele estava certo.
alter table public.purchase_order_items
  add column if not exists qty_suggested numeric(14, 4),
  add column if not exists unit_cost numeric(14, 4);

create index if not exists purchase_orders_company_created_idx
  on public.purchase_orders (company_id, created_at desc);

-- ------------------------------------------------------------------- criação
--
-- `_lines` é `[{"product_id": uuid, "qty": number}]`. A quantidade vem do
-- cliente porque o comprador ajusta (caixa fechada, MOQ, o que o fornecedor
-- tem); o resto — SKU, custo, sugestão original — é lido do snapshot aqui
-- dentro, para não haver caminho em que a tela invente um número e ele vire
-- histórico.

create or replace function public.purchase_order_create_from_snapshot(
  _company_id  uuid,
  _snapshot_id uuid,
  _lines       jsonb,
  _supplier    text default null,
  _eta_on      date default null,
  _note        text default null
) returns uuid
language plpgsql
security definer
set search_path = public, pg_catalog
as $$
declare
  _order_id uuid;
  _n        integer;
begin
  if not public.has_company_role(_company_id, 'owner', 'gestor', 'operador') then
    raise exception 'sem acesso a esta empresa' using errcode = '42501';
  end if;

  if not exists (
    select 1 from public.replenishment_snapshots
    where id = _snapshot_id and company_id = _company_id
  ) then
    raise exception 'snapshot não pertence a esta empresa' using errcode = '22023';
  end if;

  if jsonb_typeof(_lines) is distinct from 'array' or jsonb_array_length(_lines) = 0 then
    raise exception 'pedido sem linhas' using errcode = '22023';
  end if;

  insert into public.purchase_orders (
    company_id, source, status, supplier, ordered_on, eta_on, note,
    snapshot_id, params_version, created_by
  )
  select _company_id, 'reporia', 'draft', nullif(btrim(_supplier), ''),
         current_date, _eta_on, nullif(btrim(_note), ''),
         _snapshot_id, s.params_version, auth.uid()
  from public.replenishment_snapshots s
  where s.id = _snapshot_id
  returning id into _order_id;

  -- O join com o snapshot é `inner` de propósito: linha que não veio do cálculo
  -- não entra. Quantidade não-positiva é descartada aqui em vez de virar item
  -- de zero peça, que só serviria para poluir o trânsito.
  insert into public.purchase_order_items (
    company_id, order_id, product_id, sku, qty_ordered, qty_suggested, unit_cost, eta_on
  )
  select _company_id, _order_id, i.product_id, i.sku,
         (l.qty)::numeric, i.qty_to_order, i.cmv_used, _eta_on
  from jsonb_to_recordset(_lines) as l(product_id uuid, qty numeric)
  join public.replenishment_snapshot_items i
    on i.snapshot_id = _snapshot_id and i.product_id = l.product_id
  where l.qty > 0;

  get diagnostics _n = row_count;
  if _n = 0 then
    raise exception 'nenhuma linha válida no pedido' using errcode = '22023';
  end if;

  return _order_id;
end;
$$;

revoke all on function public.purchase_order_create_from_snapshot(uuid, uuid, jsonb, text, date, text) from public;
revoke all on function public.purchase_order_create_from_snapshot(uuid, uuid, jsonb, text, date, text) from anon;
revoke all on function public.purchase_order_create_from_snapshot(uuid, uuid, jsonb, text, date, text) from authenticated;
grant execute on function public.purchase_order_create_from_snapshot(uuid, uuid, jsonb, text, date, text) to authenticated;
