-- 0005_replenishment_params — parâmetros do motor, versionados e append-only.
--
-- Nada aqui é editado no lugar. Mudar um parâmetro cria uma versão nova e vira
-- a bandeira `is_current`. O motivo é auditoria: quando o pedido de compra da
-- semana que vem for 40% maior que o desta, a resposta "porque a janela de 28
-- dias foi consertada em tal dia, na versão 3" tem que estar no banco, e o
-- snapshot antigo tem que continuar reproduzível com os parâmetros da época.

do $$ begin
  create type public.recent_window_anchor as enum ('today', 'reference_date');
exception when duplicate_object then null; end $$;

do $$ begin
  create type public.reference_date_mode as enum ('max_sale_date', 'today');
exception when duplicate_object then null; end $$;

do $$ begin
  create type public.sigma_source as enum ('computed', 'external');
exception when duplicate_object then null; end $$;

do $$ begin
  create type public.sku_match_mode as enum ('exact', 'normalized');
exception when duplicate_object then null; end $$;

create table public.replenishment_params (
  id         uuid primary key default gen_random_uuid(),
  company_id uuid not null references public.companies (id) on delete cascade,
  version    integer not null,
  is_current boolean not null default true,

  lead_time_days    integer not null default 80 check (lead_time_days > 0),
  order_cycle_weeks numeric(10, 6) not null default 16 check (order_cycle_weeks > 0),
  cmv_pct           numeric(10, 6) not null default 0.20
                      check (cmv_pct > 0 and cmv_pct <= 1),

  service_level_a numeric(10, 6) not null default 0.975 check (service_level_a between 0.5 and 0.999999),
  service_level_b numeric(10, 6) not null default 0.95  check (service_level_b between 0.5 and 0.999999),
  service_level_c numeric(10, 6) not null default 0.90  check (service_level_c between 0.5 and 0.999999),

  abc_cut_a numeric(10, 6) not null default 0.50 check (abc_cut_a > 0 and abc_cut_a < 1),
  abc_cut_b numeric(10, 6) not null default 0.80 check (abc_cut_b > 0 and abc_cut_b < 1),

  recent_window_days integer not null default 28 check (recent_window_days > 0),

  -- ---- chaves de paridade ------------------------------------------------
  -- Os três achados da auditoria da planilha moram aqui. O sistema NASCE em
  -- modo legado, reproduzindo a planilha número a número, inclusive os erros.
  -- Virar cada chave é um evento datado e versionado, com snapshot antes e
  -- depois. Ver docs/divergencias.md.

  -- A coluna N da planilha ancora a janela recente em TODAY()-28 enquanto a
  -- coluna K ancora na maior data de venda. Como a base para de 2026-08-03 e
  -- hoje é setembro, a janela não pega venda nenhuma: N = 0 nos 248 SKUs, e a
  -- demanda ponderada vira metade da de longo prazo. 'today' = legado.
  recent_window_anchor public.recent_window_anchor not null default 'today',

  -- A planilha CALCULA estoque de segurança para item fora de coleção (125
  -- itens, 700 peças) e soma no agregado — `Variáveis!L7` só fecha em 426.670
  -- incluindo eles. Só PP e EMax é que ficam em branco. true = legado.
  safety_stock_for_out_of_collection boolean not null default true,

  reference_date_mode public.reference_date_mode not null default 'max_sale_date',

  -- Na planilha o desvio-padrão não é calculado: é um XLOOKUP numa base
  -- colada à mão, com 0 como valor padrão quando o SKU não está lá. Essa base
  -- está congelada em 49 semanas contra as 53 das vendas atuais. 'computed'
  -- deriva σ do próprio histórico (buckets semanais de 7 dias ancorados na
  -- menor data de venda da empresa, zeros incluídos, desvio amostral n−1);
  -- 'external' lê `external_sigma`, reproduzindo o comportamento legado.
  sigma_source public.sigma_source not null default 'computed',

  -- SUMIF e COUNTIF do Excel ignoram a caixa mas NÃO aparam espaço. As
  -- referências do fornecedor vêm sujas (`'C03CL51O  '`, `' C25AN01P'`), e por
  -- isso a planilha não enxerga 757 peças em trânsito — inclusive mandando
  -- comprar 10 peças de C27PG02O que já têm 30 a caminho. Dois códigos da
  -- lista de descontinuados também têm espaço e por isso contam como em
  -- coleção. 'exact' = legado; 'normalized' = casar por `sku_norm`.
  sku_match_mode public.sku_match_mode not null default 'exact',

  -- Só o harness de paridade usa estes dois: congelam o relógio e a base para
  -- que o resultado do motor seja comparável a uma planilha salva num dia
  -- específico. Em produção ficam nulos.
  today_override date,
  sales_cutoff_on date,

  note       text,
  created_by uuid references auth.users (id) on delete set null,
  created_at timestamptz not null default now(),

  unique (company_id, version),
  check (abc_cut_a < abc_cut_b)
);

-- Uma só versão corrente por empresa, garantido pelo banco e não pela app.
create unique index replenishment_params_current_idx
  on public.replenishment_params (company_id)
  where is_current;

-- Append-only: versão publicada não se reescreve nem se apaga. A única coluna
-- que pode mudar é `is_current` — a aposentadoria da versão quando a seguinte
-- entra. Comparar via jsonb evita listar as 18 colunas à mão e, principalmente,
-- evita que uma coluna adicionada numa migration futura escape do guard.
create or replace function public.replenishment_params_guard()
returns trigger
language plpgsql
as $$
begin
  if tg_op = 'DELETE' then
    raise exception 'replenishment_params é append-only: a versão % não pode ser apagada', old.version
      using errcode = '23514';
  end if;

  if (to_jsonb(new) - 'is_current') is distinct from (to_jsonb(old) - 'is_current') then
    raise exception
      'replenishment_params é append-only: publique uma versão nova em vez de editar a v%',
      old.version using errcode = '23514';
  end if;

  return new;
end;
$$;

revoke all on function public.replenishment_params_guard() from public;
revoke all on function public.replenishment_params_guard() from anon;
revoke all on function public.replenishment_params_guard() from authenticated;

create trigger replenishment_params_append_only
  before update or delete on public.replenishment_params
  for each row execute function public.replenishment_params_guard();

-- Publica uma versão nova a partir da corrente, aplicando um patch jsonb.
-- Devolver o id (e não a linha) mantém o contrato pequeno e estável.
create or replace function public.publish_replenishment_params(
  _company_id uuid,
  _patch jsonb,
  _note text default null
)
returns uuid
language plpgsql
security definer
set search_path = public, pg_catalog
as $$
declare
  _cur public.replenishment_params;
  _new public.replenishment_params;
  _id  uuid;
begin
  if not public.has_company_role(_company_id, 'owner', 'gestor') then
    raise exception 'sem permissão para alterar parâmetros desta empresa' using errcode = '42501';
  end if;

  select * into _cur
  from public.replenishment_params
  where company_id = _company_id and is_current;

  if not found then
    raise exception 'empresa % não tem versão corrente de parâmetros', _company_id
      using errcode = 'P0002';
  end if;

  -- `jsonb_populate_record` sobrepõe só as chaves presentes no patch.
  _new := jsonb_populate_record(_cur, _patch);

  _new.id         := gen_random_uuid();
  _new.company_id := _company_id;
  _new.version    := _cur.version + 1;
  _new.is_current := true;
  _new.note       := _note;
  _new.created_by := auth.uid();
  _new.created_at := now();

  update public.replenishment_params set is_current = false
  where company_id = _company_id and is_current;

  insert into public.replenishment_params values (_new.*) returning id into _id;
  return _id;
end;
$$;

revoke all on function public.publish_replenishment_params(uuid, jsonb, text) from public;
revoke all on function public.publish_replenishment_params(uuid, jsonb, text) from anon;
revoke all on function public.publish_replenishment_params(uuid, jsonb, text) from authenticated;
grant execute on function public.publish_replenishment_params(uuid, jsonb, text) to authenticated;

-- Empresa nova já nasce com a v1 (os valores do `Painel 1` da planilha).
create or replace function public.seed_replenishment_params()
returns trigger
language plpgsql
security definer
set search_path = public, pg_catalog
as $$
begin
  insert into public.replenishment_params (company_id, version, note)
  values (new.id, 1, 'Versão inicial — modo paridade com a planilha');
  return new;
end;
$$;

revoke all on function public.seed_replenishment_params() from public;
revoke all on function public.seed_replenishment_params() from anon;
revoke all on function public.seed_replenishment_params() from authenticated;

create trigger companies_seed_params
  after insert on public.companies
  for each row execute function public.seed_replenishment_params();

alter table public.replenishment_params enable row level security;

create policy replenishment_params_select on public.replenishment_params
  for select to authenticated using (company_id = any (public.my_company_ids()));

-- Sem INSERT/UPDATE/DELETE por policy: só via `publish_replenishment_params`.

grant select on public.replenishment_params to authenticated;

-- ---------------------------------------------------------------- σ externo
--
-- A base de desvio-padrão que a planilha consome hoje. Existe para que a
-- migração possa começar com exatamente os mesmos números de antes e só depois
-- virar a chave para o σ calculado — não é o destino, é a ponte.

create table public.external_sigma (
  company_id uuid not null references public.companies (id) on delete cascade,
  sku        text not null,
  sku_norm   text generated always as (upper(btrim(sku))) stored,
  sku_upper  text generated always as (upper(sku)) stored,
  -- Sem escala fixa: o valor vem de um desvio-padrão, é dízima, e entra num
  -- `CEIL`. Truncar em 6 casas transforma 2,0999999 em 2,1 e, um produto
  -- depois, uma peça inteira de estoque de segurança.
  sigma      numeric not null check (sigma >= 0),
  source     text,
  imported_at timestamptz not null default now(),
  primary key (company_id, sku)
);

create index external_sigma_norm_idx on public.external_sigma (company_id, sku_norm);
create index external_sigma_upper_idx on public.external_sigma (company_id, sku_upper);

alter table public.external_sigma enable row level security;

create policy external_sigma_select on public.external_sigma
  for select to authenticated using (company_id = any (public.my_company_ids()));
create policy external_sigma_write on public.external_sigma
  for all to authenticated
  using (public.has_company_role(company_id, 'owner', 'gestor', 'operador'))
  with check (public.has_company_role(company_id, 'owner', 'gestor', 'operador'));

grant select, insert, update, delete on public.external_sigma to authenticated;
