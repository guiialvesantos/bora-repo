-- 0001_foundation — tenancy, perfis e os helpers de RLS.
--
-- Multi-empresa desde o início: a associação usuário↔empresa vive em
-- `company_members` (N:N), não numa coluna `profiles.company_id`. O dono opera
-- mais de uma marca e precisa estar nas duas ao mesmo tempo.

create extension if not exists "pgcrypto";

-- ------------------------------------------------------- privilégio padrão
--
-- O Supabase deixa `alter default privileges ... grant all on tables to anon,
-- authenticated` ligado no schema `public`. O efeito é que TODA tabela criada
-- daqui para frente nasce com select/insert/update/delete para os dois papéis,
-- sem nenhuma linha de migration dizendo isso — e para `anon` isso é acesso
-- sem login, sustentado só pela RLS. Uma tabela nova que alguém esqueça de
-- proteger fica pública no instante em que é criada, e nada na tela muda.
--
-- Desligar aqui, antes da primeira `create table`, é o que faz o grant voltar
-- a ser uma decisão escrita: cada tabela abaixo diz o que concede e a quem, e
-- `scripts/audit-grants.mjs` quebra o build se `anon` alcançar qualquer coisa.
alter default privileges in schema public revoke all on tables from anon, authenticated;
alter default privileges in schema public revoke all on sequences from anon, authenticated;

-- E o que já existe: rodar num banco que já tinha tabelas não seria coberto
-- pelo `alter default privileges`, que só vale para o que vem depois.
revoke all on all tables in schema public from anon, authenticated;
revoke all on all sequences in schema public from anon, authenticated;

-- ---------------------------------------------------------------- tipos

do $$ begin
  create type public.app_role as enum ('owner', 'gestor', 'operador', 'leitor');
exception when duplicate_object then null; end $$;

-- ---------------------------------------------------------------- tabelas

create table public.companies (
  id          uuid primary key default gen_random_uuid(),
  name        text not null check (length(btrim(name)) > 0),
  slug        text not null unique check (slug ~ '^[a-z0-9][a-z0-9-]{1,48}[a-z0-9]$'),
  timezone    text not null default 'America/Sao_Paulo',
  currency    text not null default 'BRL',
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now()
);

create table public.profiles (
  id          uuid primary key references auth.users (id) on delete cascade,
  full_name   text,
  avatar_url  text,
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now()
);

create table public.company_members (
  company_id  uuid not null references public.companies (id) on delete cascade,
  user_id     uuid not null references auth.users (id) on delete cascade,
  role        public.app_role not null default 'leitor',
  created_at  timestamptz not null default now(),
  primary key (company_id, user_id)
);

create index company_members_user_idx on public.company_members (user_id);

create table public.company_invitations (
  id           uuid primary key default gen_random_uuid(),
  company_id   uuid not null references public.companies (id) on delete cascade,
  email        text not null check (position('@' in email) > 1),
  role         public.app_role not null default 'leitor',
  token_hash   text not null unique,
  invited_by   uuid references auth.users (id) on delete set null,
  expires_at   timestamptz not null default now() + interval '14 days',
  accepted_at  timestamptz,
  created_at   timestamptz not null default now()
);

create unique index company_invitations_pending_idx
  on public.company_invitations (company_id, lower(email))
  where accepted_at is null;

-- ---------------------------------------------------------------- updated_at

create or replace function public.set_updated_at()
returns trigger
language plpgsql
as $$
begin
  new.updated_at := now();
  return new;
end;
$$;

-- Função de trigger não é API. Chamar direto nem funcionaria (`new` não está
-- atribuído fora do contexto do gatilho), mas EXECUTE concedido a `anon` é
-- superfície que ninguém revisa depois — e o `scripts/audit-grants.mjs` não
-- distingue "inofensivo" de "esquecido", de propósito.
revoke all on function public.set_updated_at() from public;
revoke all on function public.set_updated_at() from anon;
revoke all on function public.set_updated_at() from authenticated;

create trigger companies_updated_at before update on public.companies
  for each row execute function public.set_updated_at();
create trigger profiles_updated_at before update on public.profiles
  for each row execute function public.set_updated_at();

-- ---------------------------------------------------------------- helpers de RLS
--
-- `my_company_ids()` devolve um ARRAY, e não um booleano por linha, de propósito:
-- num predicado de RLS a função escalar `user_can_access_company(company_id)` é
-- reavaliada linha a linha. Em `sales_order_items` (dezenas de milhares de linhas)
-- isso é a diferença entre um index scan e um seq scan com uma chamada por linha.
-- `stable` + sem argumentos deixa o planner içar a chamada para fora do loop.

create or replace function public.my_company_ids()
returns uuid[]
language sql
stable
security definer
set search_path = public, pg_catalog
as $$
  select coalesce(array_agg(company_id), '{}'::uuid[])
  from public.company_members
  where user_id = auth.uid();
$$;

create or replace function public.user_can_access_company(_company_id uuid)
returns boolean
language sql
stable
security definer
set search_path = public, pg_catalog
as $$
  select exists (
    select 1 from public.company_members
    where company_id = _company_id and user_id = auth.uid()
  );
$$;

create or replace function public.has_company_role(
  _company_id uuid,
  variadic _roles public.app_role[]
)
returns boolean
language sql
stable
security definer
set search_path = public, pg_catalog
as $$
  select exists (
    select 1 from public.company_members
    where company_id = _company_id
      and user_id = auth.uid()
      and role = any (_roles)
  );
$$;

-- `revoke from public` NÃO revoga os grants que `anon`/`authenticated` recebem
-- por herança do PUBLIC padrão do Postgres em funções. Os três revokes são
-- necessários; só depois vem o grant dirigido.
revoke all on function public.my_company_ids() from public;
revoke all on function public.my_company_ids() from anon;
revoke all on function public.my_company_ids() from authenticated;
grant execute on function public.my_company_ids() to authenticated;

revoke all on function public.user_can_access_company(uuid) from public;
revoke all on function public.user_can_access_company(uuid) from anon;
revoke all on function public.user_can_access_company(uuid) from authenticated;
grant execute on function public.user_can_access_company(uuid) to authenticated;

revoke all on function public.has_company_role(uuid, variadic public.app_role[]) from public;
revoke all on function public.has_company_role(uuid, variadic public.app_role[]) from anon;
revoke all on function public.has_company_role(uuid, variadic public.app_role[]) from authenticated;
grant execute on function public.has_company_role(uuid, variadic public.app_role[]) to authenticated;

-- ---------------------------------------------------------------- bootstrap
--
-- `INSERT ... RETURNING` é validado contra a política de SELECT também (precisa
-- reler a linha). Criar empresa e só depois inserir o membro daria erro: no
-- momento do RETURNING o usuário ainda não é membro, logo não enxerga a empresa.
-- Por isso os dois inserts vivem numa função SECURITY DEFINER atômica.

create or replace function public.create_company(_name text, _slug text)
returns uuid
language plpgsql
security definer
set search_path = public, pg_catalog
as $$
declare
  _uid uuid := auth.uid();
  _id  uuid;
begin
  if _uid is null then
    raise exception 'não autenticado' using errcode = '42501';
  end if;

  insert into public.companies (name, slug) values (_name, _slug) returning id into _id;
  insert into public.company_members (company_id, user_id, role) values (_id, _uid, 'owner');
  insert into public.profiles (id) values (_uid) on conflict (id) do nothing;

  return _id;
end;
$$;

revoke all on function public.create_company(text, text) from public;
revoke all on function public.create_company(text, text) from anon;
revoke all on function public.create_company(text, text) from authenticated;
grant execute on function public.create_company(text, text) to authenticated;

-- Perfil nasce junto com o usuário do Auth.
create or replace function public.handle_new_user()
returns trigger
language plpgsql
security definer
set search_path = public, pg_catalog
as $$
begin
  insert into public.profiles (id, full_name)
  values (new.id, nullif(btrim(coalesce(new.raw_user_meta_data ->> 'full_name', '')), ''))
  on conflict (id) do nothing;
  return new;
end;
$$;

revoke all on function public.handle_new_user() from public;
revoke all on function public.handle_new_user() from anon;
revoke all on function public.handle_new_user() from authenticated;

drop trigger if exists on_auth_user_created on auth.users;
create trigger on_auth_user_created
  after insert on auth.users
  for each row execute function public.handle_new_user();

-- ---------------------------------------------------------------- RLS

alter table public.companies           enable row level security;
alter table public.profiles            enable row level security;
alter table public.company_members     enable row level security;
alter table public.company_invitations enable row level security;

create policy companies_select on public.companies
  for select to authenticated
  using (id = any (public.my_company_ids()));

create policy companies_update on public.companies
  for update to authenticated
  using (public.has_company_role(id, 'owner'))
  with check (public.has_company_role(id, 'owner'));

-- Sem policy de INSERT: empresa só nasce por `create_company()`.
-- Sem policy de DELETE em lugar nenhum deste schema.

create policy profiles_select_self on public.profiles
  for select to authenticated using (id = auth.uid());

create policy profiles_update_self on public.profiles
  for update to authenticated
  using (id = auth.uid()) with check (id = auth.uid());

create policy company_members_select on public.company_members
  for select to authenticated
  using (company_id = any (public.my_company_ids()));

create policy company_members_write on public.company_members
  for all to authenticated
  using (public.has_company_role(company_id, 'owner'))
  with check (public.has_company_role(company_id, 'owner'));

create policy company_invitations_select on public.company_invitations
  for select to authenticated
  using (public.has_company_role(company_id, 'owner', 'gestor'));

create policy company_invitations_write on public.company_invitations
  for all to authenticated
  using (public.has_company_role(company_id, 'owner', 'gestor'))
  with check (public.has_company_role(company_id, 'owner', 'gestor'));

-- ---------------------------------------------------------------- grants
--
-- Nada de `grant ... on all tables in schema public to authenticated`: isso
-- cobre também as tabelas que ainda nem existem na cabeça de quem escreve a
-- migration seguinte. Cada tabela recebe o seu grant explicitamente.

grant usage on schema public to authenticated;

grant select                         on public.companies           to authenticated;
grant update                         on public.companies           to authenticated;
grant select, update                 on public.profiles            to authenticated;
grant select, insert, update, delete on public.company_members     to authenticated;
grant select, insert, update, delete on public.company_invitations to authenticated;
