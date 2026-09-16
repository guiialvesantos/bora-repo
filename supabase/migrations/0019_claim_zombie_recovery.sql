-- 0019 — recuperação de jobs zumbis no claim
--
-- Um isolate do Edge Runtime pode morrer no meio do processamento (limite de
-- wall clock / CPU) sem executar o finally que devolveria o job à fila. O job
-- fica preso em `running` para sempre e, como o claim só olha `queued`, a
-- corrente daquele kind morre em silêncio — aconteceu com o `products_stock`
-- da All Out em 14/09/2026 (updated_at congelado às 21:47).
--
-- Regra: `running` sem update há mais de 5 minutos é zumbi — o orçamento de
-- uma rodada é 100 s, então 5 min é folga larga. O próprio claim ressuscita
-- (status volta a `queued`) antes de escolher o próximo. `attempts` já conta
-- no claim; um job que zumbifica em loop acumula attempts e fica auditável.

create or replace function public.sync_jobs_claim()
returns public.sync_jobs
language plpgsql
security definer
set search_path to 'public', 'pg_catalog'
as $function$
declare
  _job public.sync_jobs;
begin
  update public.sync_jobs
  set status = 'queued'
  where status = 'running'
    and updated_at < now() - interval '5 minutes';

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
$function$;
