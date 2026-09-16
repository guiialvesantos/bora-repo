-- 0028_demand_daily_profile — o ritmo semanal da demanda, medido.
--
-- O motor trabalha em semanas: `weekly_blended` é uma taxa de sete dias, e é o
-- número certo para dimensionar ES/PP/Emáx. Mas a projeção do Painel desenha
-- DIAS, e dividir a semana por sete espalha a venda em partes iguais — o que
-- produz uma reta perfeita e uma afirmação que os dados desmentem: na Triana o
-- domingo vende 48% de um dia médio e a sexta, 126%.
--
-- Esta função devolve sete pesos, um por dia da semana, com média 1. Multiplicar
-- a taxa diária por eles não muda NADA do total semanal — muda só a distribuição
-- dentro da semana. A política, o ponto de pedido e o lote continuam intactos;
-- o que muda é a linha parar de mentir que segunda e domingo são iguais.
--
-- Fora da projeção ninguém consome isto. É explicitamente um detalhe de
-- desenho da curva, não uma entrada do cálculo de reposição.

create or replace function public.demand_daily_profile(_company_id uuid)
returns jsonb
language plpgsql
stable
security definer
set search_path = public, pg_catalog
as $$
declare
  _span_days int;
  _units     numeric;
  _weights   numeric[];
begin
  if not public.user_can_access_company(_company_id) then
    raise exception 'sem acesso a esta empresa' using errcode = '42501';
  end if;

  with src as (
    select sold_on, qty
    from public.sales_order_items
    where company_id = _company_id
      and sold_on >= current_date - 365
  ),
  span as (
    select min(sold_on) as lo, max(sold_on) as hi, coalesce(sum(qty), 0) as units
    from src
  ),
  -- O denominador é quantas vezes aquele dia da semana OCORREU na janela, não
  -- quantas vezes ele vendeu. Contando só os dias com venda, um domingo que
  -- vende raro mas vende muito viraria o dia mais forte da semana.
  cal as (
    select d::date as d
    from span, generate_series(span.lo, span.hi, interval '1 day') d
    where span.lo is not null
  ),
  dow_days as (
    select extract(dow from d)::int as dow, count(*)::numeric as days
    from cal group by 1
  ),
  dow_units as (
    select extract(dow from sold_on)::int as dow, sum(qty) as units
    from src group by 1
  ),
  grid as (
    select g.dow,
           coalesce(u.units, 0) as units,
           coalesce(d.days, 0)  as days
    from generate_series(0, 6) g(dow)
    left join dow_units u on u.dow = g.dow
    left join dow_days  d on d.dow = g.dow
  ),
  rate as (
    select dow, case when days > 0 then units / days else 0 end as per_day
    from grid
  ),
  norm as (
    select dow,
           case
             when (select avg(per_day) from rate) > 0
               -- Trava em [0,2 ; 3]: uma Black Friday numa sexta não pode fazer
               -- a projeção inteira acreditar que toda sexta vende o triplo.
               then least(3, greatest(0.2, per_day / (select avg(per_day) from rate)))
             else 1
           end as w
    from rate
  )
  select
    (select (span.hi - span.lo) + 1 from span),
    (select units from span),
    -- Renormaliza depois da trava, senão a média deixa de ser 1 e o total
    -- semanal projetado passaria a divergir do `weekly_blended` do motor.
    (select array_agg(w / (select avg(w) from norm) order by dow) from norm)
  into _span_days, _units, _weights;

  -- Amostra curta ou magra não tem forma: devolve reta e diz por quê. Sete
  -- pesos tirados de três semanas seriam ruído desenhado com confiança.
  if _span_days is null or _span_days < 56 or coalesce(_units, 0) < 140 then
    return jsonb_build_object(
      'weights', jsonb_build_array(1, 1, 1, 1, 1, 1, 1),
      'source', 'flat',
      'span_days', coalesce(_span_days, 0),
      'units', coalesce(_units, 0)
    );
  end if;

  return jsonb_build_object(
    'weights', to_jsonb(_weights),
    'source', 'sales',
    'span_days', _span_days,
    'units', _units
  );
end;
$$;

comment on function public.demand_daily_profile(uuid) is
  'Sete pesos de média 1, um por dia da semana, medidos da venda dos últimos 365 dias. '
  'Só a projeção do Painel consome — não entra em ES/PP/Emáx.';

revoke all on function public.demand_daily_profile(uuid) from public;
revoke all on function public.demand_daily_profile(uuid) from anon;
revoke all on function public.demand_daily_profile(uuid) from authenticated;
grant execute on function public.demand_daily_profile(uuid) to authenticated;
