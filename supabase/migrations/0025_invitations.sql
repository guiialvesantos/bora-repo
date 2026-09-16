-- 0025_invitations — convidar membros para uma empresa, por link.
--
-- A tabela `company_invitations` existe desde a 0001 e nunca foi usada: o único
-- caminho para entrar numa empresa era `create_company()`, que faz de quem
-- clicou o dono. Esta migration liga a tabela.
--
-- Três decisões que valem explicação:
--
-- 1. O token NUNCA é guardado. A tabela tem `token_hash`, e é isso que fica.
--    Quem cria o convite vê o link uma vez; depois nem o dono nem o banco
--    conseguem reconstruí-lo. Perder o link não é problema — gerar outro
--    invalida o anterior, que é o mesmo botão de "reenviar".
--
-- 2. Aceitar exige que o e-mail do convite bata com o e-mail de quem está
--    logado. O link é portador: quem o tem, o tem. A amarração ao e-mail é o
--    que impede que um link repassado em grupo vire acesso para o grupo todo.
--
-- 3. Não existe prévia anônima do convite. Seria confortável mostrar "você foi
--    convidado para a All Out" antes do login, mas isso obrigaria a expor uma
--    função a `anon` — e `scripts/audit-grants.mjs` quebra o build justamente
--    para impedir isso. O nome da empresa aparece depois que a pessoa prova
--    quem é, e essa ordem é a correta de qualquer forma.

-- ---------------------------------------------------------------- criar

create or replace function public.invitation_create(
  _company_id uuid,
  _email      text,
  _role       public.app_role
)
returns text
language plpgsql
security definer
set search_path = public, pg_catalog
as $$
declare
  _uid   uuid := auth.uid();
  _mail  text := lower(btrim(coalesce(_email, '')));
  _token text;
begin
  if _uid is null then
    raise exception 'não autenticado' using errcode = '42501';
  end if;

  if not public.has_company_role(_company_id, 'owner', 'gestor') then
    raise exception 'sem permissão para convidar nesta empresa' using errcode = '42501';
  end if;

  -- Só dono convida dono. Sem esta linha, um gestor convida um e-mail que ele
  -- controla como `owner`, aceita, e a empresa ganha um dono que ninguém
  -- autorizou — escalação de privilégio por um caminho que parece rotina.
  if _role = 'owner' and not public.has_company_role(_company_id, 'owner') then
    raise exception 'só o dono pode convidar outro dono' using errcode = '42501';
  end if;

  if position('@' in _mail) < 2 then
    raise exception 'e-mail inválido' using errcode = '22023';
  end if;

  if exists (
    select 1
    from public.company_members m
    join auth.users u on u.id = m.user_id
    where m.company_id = _company_id and lower(u.email) = _mail
  ) then
    raise exception 'esse e-mail já é membro da empresa' using errcode = '23505';
  end if;

  _token := encode(extensions.gen_random_bytes(24), 'hex');

  -- Convidar de novo troca o convite, e o link anterior morre na hora. Dois
  -- links válidos para o mesmo e-mail é o tipo de coisa que ninguém consegue
  -- auditar depois.
  delete from public.company_invitations
  where company_id = _company_id and lower(email) = _mail and accepted_at is null;

  insert into public.company_invitations (company_id, email, role, token_hash, invited_by)
  values (
    _company_id, _mail, _role,
    encode(extensions.digest(_token, 'sha256'), 'hex'),
    _uid
  );

  return _token;
end;
$$;

-- ---------------------------------------------------------------- revogar

create or replace function public.invitation_revoke(_id uuid)
returns void
language plpgsql
security definer
set search_path = public, pg_catalog
as $$
declare
  _company uuid;
begin
  select company_id into _company
  from public.company_invitations
  where id = _id and accepted_at is null;

  -- Convite inexistente e convite de outra empresa devolvem a mesma coisa: a
  -- mensagem de erro não deve dizer se o id existe em algum outro tenant.
  if _company is null or not public.has_company_role(_company, 'owner', 'gestor') then
    raise exception 'convite não encontrado' using errcode = '42501';
  end if;

  delete from public.company_invitations where id = _id;
end;
$$;

-- ---------------------------------------------------------------- aceitar

create or replace function public.invitation_accept(_token text)
returns uuid
language plpgsql
security definer
set search_path = public, pg_catalog
as $$
declare
  _uid  uuid := auth.uid();
  _mail text;
  _inv  public.company_invitations%rowtype;
begin
  if _uid is null then
    raise exception 'não autenticado' using errcode = '42501';
  end if;

  select lower(email) into _mail from auth.users where id = _uid;

  select * into _inv
  from public.company_invitations
  where token_hash = encode(extensions.digest(coalesce(_token, ''), 'sha256'), 'hex')
    and accepted_at is null
    and expires_at > now();

  if _inv.id is null then
    raise exception 'convite inválido, expirado ou já usado' using errcode = 'P0002';
  end if;

  if lower(_inv.email) <> _mail then
    raise exception 'este convite é para %, e você está logado como %', _inv.email, _mail
      using errcode = '42501';
  end if;

  -- `do nothing` e não `do update`: se a pessoa já é membro, aceitar de novo
  -- não pode ser um caminho para trocar o próprio papel.
  insert into public.company_members (company_id, user_id, role)
  values (_inv.company_id, _uid, _inv.role)
  on conflict (company_id, user_id) do nothing;

  insert into public.profiles (id) values (_uid) on conflict (id) do nothing;

  update public.company_invitations set accepted_at = now() where id = _inv.id;

  return _inv.company_id;
end;
$$;

-- ---------------------------------------------------------------- listar membros
--
-- `profiles` só deixa cada um ver o próprio registro, e o e-mail nem mora lá.
-- Sem esta função a tela de equipe mostraria uma lista de uuids.

create or replace function public.company_members_list(_company_id uuid)
returns table (
  user_id    uuid,
  email      text,
  full_name  text,
  role       public.app_role,
  created_at timestamptz
)
language sql
stable
security definer
set search_path = public, pg_catalog
as $$
  select m.user_id, u.email::text, p.full_name, m.role, m.created_at
  from public.company_members m
  join auth.users u on u.id = m.user_id
  left join public.profiles p on p.id = m.user_id
  where m.company_id = _company_id
    and public.user_can_access_company(_company_id)
  order by m.created_at;
$$;

-- ---------------------------------------------------------------- políticas
--
-- A policy de escrita da 0001 dava INSERT direto a owner e gestor. Com ela um
-- gestor escolhia o próprio `token_hash` e o próprio `role` — inclusive
-- `owner`. Toda escrita passa a ser pelas funções acima, que checam o papel.

drop policy if exists company_invitations_write on public.company_invitations;

revoke insert, update, delete on public.company_invitations from authenticated;

-- ---------------------------------------------------------------- grants

revoke all on function public.invitation_create(uuid, text, public.app_role) from public;
revoke all on function public.invitation_create(uuid, text, public.app_role) from anon;
revoke all on function public.invitation_create(uuid, text, public.app_role) from authenticated;
grant execute on function public.invitation_create(uuid, text, public.app_role) to authenticated;

revoke all on function public.invitation_revoke(uuid) from public;
revoke all on function public.invitation_revoke(uuid) from anon;
revoke all on function public.invitation_revoke(uuid) from authenticated;
grant execute on function public.invitation_revoke(uuid) to authenticated;

revoke all on function public.invitation_accept(text) from public;
revoke all on function public.invitation_accept(text) from anon;
revoke all on function public.invitation_accept(text) from authenticated;
grant execute on function public.invitation_accept(text) to authenticated;

revoke all on function public.company_members_list(uuid) from public;
revoke all on function public.company_members_list(uuid) from anon;
revoke all on function public.company_members_list(uuid) from authenticated;
grant execute on function public.company_members_list(uuid) to authenticated;
