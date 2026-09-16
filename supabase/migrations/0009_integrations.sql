-- 0009_integrations — conector Olist (Tiny API v2): conexão, fila e limitador.
--
-- Fase 2 do plano: só produtos e estoque. São endpoints pequenos e sem N+1 —
-- provam o token, o rate limiter e a fila em terreno seguro antes de vendas
-- (fase 3), que tem o problema do N+1 de pedido por pedido.
--
-- O token nunca passa pelo navegador em texto puro depois de digitado: a UI
-- chama uma Edge Function com service_role, que criptografa e grava. Por isso
-- `integration_secrets` não tem NENHUMA policy — só `service_role` alcança.

create table public.integration_connections (
  id            uuid primary key default gen_random_uuid(),
  company_id    uuid not null references public.companies (id) on delete cascade,
  -- Texto, não enum: só existe token v2 hoje, mas o cliente já é abstraído
  -- para trocar de provider (v3) sem migration nova.
  provider      text not null default 'tiny_v2',
  status        text not null default 'disconnected'
                check (status in ('disconnected', 'connected', 'error')),
  last_error    text,
  -- Mapa de depósito (external_id → include_in_available) e filtro de
  -- situação de pedido. Não é segredo; pode ser lido e ajustado pelo cliente.
  settings      jsonb not null default '{}'::jsonb,
  -- Segmento não adivinhável da URL do webhook (`/tiny-webhook/<token>`). Não
  -- é segredo do mesmo jeito que o token do Tiny — não decide nada sozinho,
  -- só evita que alguém de fora enfileire eventos falsos nesta empresa.
  webhook_token text not null default encode(extensions.gen_random_bytes(16), 'hex') unique,
  connected_at  timestamptz,
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now(),
  unique (company_id, provider)
);

create table public.integration_secrets (
  connection_id uuid primary key references public.integration_connections (id) on delete cascade,
  ciphertext    text not null,
  iv            text not null,
  key_version   integer not null default 1,
  updated_at    timestamptz not null default now()
);

-- Fila de trabalho resumível. Fase 2 só enfileira `products_stock`; fase 3
-- acrescenta `order_backfill`/`order_detail` sem precisar de migration nova
-- (kind é texto, não enum).
create table public.sync_jobs (
  id           uuid primary key default gen_random_uuid(),
  company_id   uuid not null references public.companies (id) on delete cascade,
  connection_id uuid not null references public.integration_connections (id) on delete cascade,
  kind         text not null,
  payload      jsonb not null default '{}'::jsonb,
  -- Chave de deduplicação: só é única ENTRE os jobs vivos (partial index
  -- abaixo). Um job concluído não impede reenfileirar o mesmo trabalho depois.
  dedupe_key   text,
  priority     integer not null default 100,
  status       text not null default 'queued'
               check (status in ('queued', 'running', 'done', 'error')),
  attempts     integer not null default 0,
  last_error   text,
  run_after    timestamptz not null default now(),
  created_at   timestamptz not null default now(),
  updated_at   timestamptz not null default now()
);

create unique index sync_jobs_dedupe_live_idx on public.sync_jobs (dedupe_key)
  where dedupe_key is not null and status in ('queued', 'running');

create index sync_jobs_claim_idx on public.sync_jobs (priority desc, run_after)
  where status = 'queued';

create table public.sync_runs (
  id            uuid primary key default gen_random_uuid(),
  company_id    uuid not null references public.companies (id) on delete cascade,
  connection_id uuid not null references public.integration_connections (id) on delete cascade,
  kind          text not null,
  status        text not null default 'running'
                check (status in ('running', 'done', 'paused', 'error')),
  resource      text,
  cursor        text,
  processed     integer not null default 0,
  error         text,
  triggered_by  uuid references auth.users (id) on delete set null,
  started_at    timestamptz not null default now(),
  finished_at   timestamptz
);

create index sync_runs_company_idx on public.sync_runs (company_id, kind, started_at desc);

-- Log do webhook. A regra que faz as retentativas do Tiny serem inofensivas:
-- o handler NUNCA calcula aqui dentro, só grava a linha e enfileira um job —
-- processar dez vezes o mesmo evento vira dez upserts idênticos, não dez
-- efeitos.
create table public.integration_webhook_events (
  id            uuid primary key default gen_random_uuid(),
  company_id    uuid not null references public.companies (id) on delete cascade,
  connection_id uuid not null references public.integration_connections (id) on delete cascade,
  event_type    text,
  payload       jsonb not null,
  received_at   timestamptz not null default now()
);

create index integration_webhook_events_company_idx
  on public.integration_webhook_events (company_id, received_at desc);

-- Bucket adaptativo: 429 derruba `refill_per_sec` pela metade, 200 chamadas
-- limpas sobem 10%. O limite do v2 não é documentado, então o número certo só
-- se descobre em produção — daí ser ajustável em vez de uma constante no código.
create table public.integration_rate_limits (
  connection_id   uuid primary key references public.integration_connections (id) on delete cascade,
  capacity        numeric not null default 30,
  tokens          numeric not null default 30,
  refill_per_sec  numeric not null default 2,
  clean_streak    integer not null default 0,
  updated_at      timestamptz not null default now()
);

create trigger integration_connections_updated_at before update on public.integration_connections
  for each row execute function public.set_updated_at();
create trigger sync_jobs_updated_at before update on public.sync_jobs
  for each row execute function public.set_updated_at();

-- ---------------------------------------------------------------- RLS

alter table public.integration_connections  enable row level security;
alter table public.integration_secrets      enable row level security;
alter table public.sync_jobs                enable row level security;
alter table public.sync_runs                enable row level security;
alter table public.integration_rate_limits  enable row level security;
alter table public.integration_webhook_events enable row level security;

-- Conexão é visível a quem administra a empresa; a escrita (inclusive trocar
-- o mapa de depósitos) passa pela Edge Function porque criar/testar a conexão
-- já exige validar o token contra o Tiny antes de gravar qualquer coisa.
create policy integration_connections_select on public.integration_connections
  for select to authenticated
  using (public.has_company_role(company_id, 'owner', 'gestor'));

create policy sync_jobs_select on public.sync_jobs
  for select to authenticated
  using (public.has_company_role(company_id, 'owner', 'gestor'));

create policy sync_runs_select on public.sync_runs
  for select to authenticated
  using (public.has_company_role(company_id, 'owner', 'gestor'));

create policy integration_webhook_events_select on public.integration_webhook_events
  for select to authenticated
  using (public.has_company_role(company_id, 'owner', 'gestor'));

-- `integration_secrets` e `integration_rate_limits` não têm NENHUMA policy:
-- RLS ligada e zero `create policy` é um cadeado, não um esquecimento — só
-- `service_role` (que ignora RLS) alcança. Ver o comentário do topo.

grant select on public.integration_connections   to authenticated;
grant select on public.sync_jobs                 to authenticated;
grant select on public.sync_runs                 to authenticated;
grant select on public.integration_webhook_events to authenticated;

-- Nada de grant para anon/authenticated em `integration_secrets` e
-- `integration_rate_limits`: nem select. O revoke geral do 0001 já cobre isto
-- para tabela nova, mas fica explícito aqui porque o conteúdo é sensível.
revoke all on public.integration_secrets     from anon, authenticated;
revoke all on public.integration_rate_limits from anon, authenticated;

-- `service_role` ignora RLS, mas RLS não é grant: sem privilégio de tabela
-- explícito, o Postgres barra a query antes mesmo de avaliar policy
-- ("permission denied for table..."). Nenhuma migration anterior concedeu
-- nada a `service_role` porque, até aqui, toda escrita de admin passava por
-- função SECURITY DEFINER (dono = postgres, que não olha grant de tabela).
-- As Edge Functions do Tiny são o primeiro código a fazer
-- `admin.from(tabela).insert/upsert/update(...)` direto — por isso o grant
-- fica explícito aqui, tabela por tabela, em vez de `grant all on all
-- tables` (que a 0001 evita de propósito).
grant select, insert, update, delete on public.integration_connections     to service_role;
grant select, insert, update, delete on public.integration_secrets        to service_role;
grant select, insert, update, delete on public.sync_jobs                  to service_role;
grant select, insert, update, delete on public.sync_runs                  to service_role;
grant select, insert, update, delete on public.integration_rate_limits    to service_role;
grant select, insert         on public.integration_webhook_events         to service_role;

-- `tiny-sync-worker` também escreve direto nestas tabelas do catálogo
-- (0002) e em `data_sources` (0008), que até aqui só eram gravadas via RPC
-- SECURITY DEFINER — mesmo motivo do bloco acima.
grant select, insert, update on public.warehouses     to service_role;
grant select, insert, update on public.products       to service_role;
grant select, insert, update on public.product_stock  to service_role;
grant select, insert, update on public.data_sources   to service_role;

-- ---------------------------------------------------------------- fila

-- Reivindica o próximo job pronto para rodar, com `FOR UPDATE SKIP LOCKED`
-- para dois workers concorrentes nunca pegarem o mesmo job. Chamada só pelo
-- worker via service_role — não é RPC de usuário, por isso não recebe grant
-- de `authenticated`.
create or replace function public.sync_jobs_claim()
returns public.sync_jobs
language plpgsql
security definer
set search_path = public, pg_catalog
as $$
declare
  _job public.sync_jobs;
begin
  select * into _job
  from public.sync_jobs
  where status = 'queued' and run_after <= now()
  order by priority desc, run_after
  for update skip locked
  limit 1;

  if _job.id is not null then
    update public.sync_jobs
    set status = 'running', attempts = attempts + 1
    where id = _job.id
    returning * into _job;
  end if;

  return _job;
end;
$$;

revoke all on function public.sync_jobs_claim() from public;
revoke all on function public.sync_jobs_claim() from anon;
revoke all on function public.sync_jobs_claim() from authenticated;
