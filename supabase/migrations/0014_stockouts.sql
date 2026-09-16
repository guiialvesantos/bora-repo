-- 0014_stockouts — registro de rupturas (demanda censurada por falta de estoque)
--
-- O motor lê venda realizada, e venda zero com estoque zero não é demanda
-- zero — é demanda que ficou invisível ("demanda censurada"). `product_stock`
-- guarda só a posição atual, então a única forma de saber QUANDO faltou é
-- registrar a transição no momento em que ela acontece.
--
-- Trigger no banco, não código no worker: o estoque muda por mais de um
-- caminho (sync completo, webhook, import manual) e todos convergem em
-- `product_stock`. Detectar a transição aqui cobre qualquer caminho futuro
-- sem ninguém lembrar de avisar.
--
-- Nada consome esta tabela ainda. O uso no σ/demanda (excluir ou imputar
-- semanas censuradas) entra depois, atrás de flag versionada, quando houver
-- meses de coleta. Registrar primeiro, calcular depois — o passado não é
-- recuperável, então cada dia sem coletar é um dia perdido para sempre.

create table public.stockout_periods (
  id         uuid primary key default gen_random_uuid(),
  company_id uuid not null references public.companies (id) on delete cascade,
  product_id uuid not null references public.products (id) on delete cascade,
  started_at timestamptz not null default now(),
  -- Nulo = ruptura em aberto (o produto está sem estoque agora).
  ended_at   timestamptz,
  -- 'trigger' = pego na hora; 'reconcile' = pego pela varredura diária (ou
  -- pelo seed desta migration). Serve para auditar se o trigger está vazando.
  opened_by  text not null default 'trigger',
  created_at timestamptz not null default now()
);

-- No máximo um período aberto por produto — é o alvo do ON CONFLICT abaixo.
create unique index stockout_periods_open_uq
  on public.stockout_periods (product_id) where ended_at is null;
create index stockout_periods_company_idx
  on public.stockout_periods (company_id, started_at);

alter table public.stockout_periods enable row level security;

create policy stockout_periods_select on public.stockout_periods
  for select to authenticated
  using (company_id = any (public.my_company_ids()));

-- Escrita só pelas funções SECURITY DEFINER abaixo (e service_role). A UI
-- nunca escreve ruptura na mão — o dado só vale se for automático.
grant select on public.stockout_periods to authenticated;
grant select, insert, update on public.stockout_periods to service_role;

-- ----------------------------------------------------------------------------
-- Disponível de um produto: MESMA definição do motor (0007, CTE `base`) —
-- soma só dos depósitos com `include_in_available`. Se as duas contas
-- divergirem, "ruptura" e "estoque zero na tela" contariam coisas diferentes.
-- ----------------------------------------------------------------------------
create or replace function public.product_available(_product_id uuid)
returns numeric
language sql
stable
set search_path = public, pg_catalog
as $$
  select coalesce((
    select sum(ps.qty)
    from public.product_stock ps
    join public.warehouses w on w.id = ps.warehouse_id
    where ps.product_id = _product_id and w.include_in_available
  ), 0)
$$;

revoke all on function public.product_available(uuid) from public;
revoke all on function public.product_available(uuid) from anon;
grant execute on function public.product_available(uuid) to authenticated;

create or replace function public.track_stockout()
returns trigger
language plpgsql
security definer
set search_path = public, pg_catalog
as $$
declare
  _pid   uuid := coalesce(new.product_id, old.product_id);
  _cid   uuid := coalesce(new.company_id, old.company_id);
  _avail numeric;
begin
  -- DELETE em cascata (produto sendo apagado): o pai já saiu; abrir período
  -- aqui violaria a FK. Ruptura de produto que deixou de existir não é dado.
  if not exists (select 1 from public.products p where p.id = _pid) then
    return null;
  end if;

  _avail := public.product_available(_pid);

  if _avail <= 0 then
    insert into public.stockout_periods (company_id, product_id)
    values (_cid, _pid)
    on conflict (product_id) where ended_at is null do nothing;
  else
    update public.stockout_periods
      set ended_at = now()
      where product_id = _pid and ended_at is null;
  end if;
  return null;
end;
$$;

revoke all on function public.track_stockout() from public;
revoke all on function public.track_stockout() from anon;
revoke all on function public.track_stockout() from authenticated;

-- Dois triggers em vez de um: o sync completo faz upsert de todos os SKUs a
-- cada rodada e quase nenhum muda — o WHEN corta esses no-ops antes de rodar
-- a função (WHEN com OLD não é permitido em INSERT, daí a separação).
create trigger product_stock_stockout_ins
  after insert or delete on public.product_stock
  for each row execute function public.track_stockout();

create trigger product_stock_stockout_upd
  after update on public.product_stock
  for each row
  when (old.qty is distinct from new.qty)
  execute function public.track_stockout();

-- ----------------------------------------------------------------------------
-- Reconciliação: rede de segurança diária. Se um sync falhou no meio, um
-- depósito mudou de `include_in_available`, ou um produto foi inativado, o
-- trigger não viu — a varredura conserta. Também é o seed: a primeira
-- execução abre período para tudo que JÁ está zerado hoje.
-- ----------------------------------------------------------------------------
create or replace function public.stockout_reconcile()
returns void
language plpgsql
security definer
set search_path = public, pg_catalog
as $$
begin
  -- Fecha: produto voltou a ter estoque, ou saiu do catálogo ativo (ruptura
  -- de item inativo não é demanda censurada — é fim de linha).
  update public.stockout_periods sp
    set ended_at = now()
    where sp.ended_at is null
      and (
        not exists (select 1 from public.products p where p.id = sp.product_id and p.is_active)
        or public.product_available(sp.product_id) > 0
      );

  -- Abre: ativo, zerado, sem período aberto.
  insert into public.stockout_periods (company_id, product_id, opened_by)
  select p.company_id, p.id, 'reconcile'
  from public.products p
  where p.is_active
    and public.product_available(p.id) <= 0
  on conflict (product_id) where ended_at is null do nothing;
end;
$$;

revoke all on function public.stockout_reconcile() from public;
revoke all on function public.stockout_reconcile() from anon;
revoke all on function public.stockout_reconcile() from authenticated;

-- Seed: registra o estado de agora. `started_at = hoje` é o melhor que dá —
-- não existe histórico para saber desde quando esses itens estão zerados.
select public.stockout_reconcile();

-- 06:30 UTC = 03:30 em America/Sao_Paulo, fora do horário de sync pesado.
select cron.schedule('stockout-reconcile-daily', '30 6 * * *',
  $$select public.stockout_reconcile()$$);
