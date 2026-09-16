-- 0010_tiny_sync_cron — dispara tiny-sync-worker a cada minuto via pg_cron+pg_net.
--
-- Gap real descoberto em produção: `tiny-connect` enfileira o job em
-- `sync_jobs`, mas nada nunca invocava o worker sozinho — o job ficava
-- parado em "queued" até alguém chamar a function na mão.
--
-- URL do projeto e o segredo do worker não entram aqui como literal: ficam no
-- Vault (`vault.create_secret`, inserido uma vez por ambiente, fora de
-- migration). Sem o segredo (dev local, projeto novo antes do setup), a
-- function abaixo não falha o cron — só não faz nada.

create extension if not exists pg_cron with schema pg_catalog;
create extension if not exists pg_net with schema extensions;

create or replace function public.trigger_tiny_sync_worker()
returns void
language plpgsql
security definer
set search_path = public, extensions, vault, pg_catalog
as $$
declare
  _url text;
  _secret text;
begin
  select decrypted_secret into _url
  from vault.decrypted_secrets where name = 'tiny_sync_worker_url';
  select decrypted_secret into _secret
  from vault.decrypted_secrets where name = 'tiny_sync_secret';

  if _url is null or _secret is null then
    return; -- ambiente sem os segredos configurados (ex.: dev local); no-op.
  end if;

  perform net.http_post(
    url := _url,
    headers := jsonb_build_object('Authorization', 'Bearer ' || _secret, 'Content-Type', 'application/json'),
    body := '{}'::jsonb
  );
end;
$$;

revoke all on function public.trigger_tiny_sync_worker() from public;
revoke all on function public.trigger_tiny_sync_worker() from anon;
revoke all on function public.trigger_tiny_sync_worker() from authenticated;

select cron.schedule('tiny-sync-worker-minute', '* * * * *', $$select public.trigger_tiny_sync_worker()$$);
