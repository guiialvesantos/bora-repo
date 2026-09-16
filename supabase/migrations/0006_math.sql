-- 0006_math — inversa da normal padrão, algoritmo AS241 de Wichura (1988).
--
-- Por que no banco e não no cliente: o Z entra no estoque de segurança, o
-- estoque de segurança é calculado em SQL, e o número que aparece na tela tem
-- que vir do mesmo caminho de código do número que foi gravado no snapshot.
-- Duas implementações do mesmo algoritmo é uma a mais do que o necessário.
--
-- Por que AS241 e não Acklam: Acklam erra ~1,15e-9. O ES sai de um `CEIL`, e
-- um erro de 1e-9 sobre um produto que cai exatamente num inteiro vira uma peça
-- inteira de diferença — justamente o tipo de divergência silenciosa que o
-- harness de paridade existe para impedir. AS241 tem erro ~1e-16, que é o
-- mesmo patamar do `NORM.S.INV` do Excel.

create or replace function public.norm_s_inv(p double precision)
returns double precision
language plpgsql
immutable
parallel safe
as $$
declare
  q double precision;
  r double precision;
begin
  if p is null then return null; end if;
  if p <= 0 or p >= 1 then
    raise exception 'norm_s_inv: p deve estar em (0,1), recebido %', p using errcode = '22023';
  end if;

  q := p - 0.5;

  if abs(q) <= 0.425 then
    r := 0.180625 - q * q;
    return q * (((((((2509.0809287301226727 * r + 33430.575583588128105) * r
                      + 67265.770927008700853) * r + 45921.953931549871457) * r
                      + 13731.693765509461125) * r + 1971.5909503065514427) * r
                      + 133.14166789178437745) * r + 3.387132872796366608)
             / (((((((5226.495278852545925 * r + 28729.085735721942674) * r
                      + 39307.89580009271061) * r + 21213.794301586595867) * r
                      + 5394.1960214247511077) * r + 687.1870074920579083) * r
                      + 42.313330701600911252) * r + 1.0);
  end if;

  if q < 0 then r := p; else r := 1.0 - p; end if;
  r := sqrt(-ln(r));

  if r <= 5.0 then
    r := r - 1.6;
    r := (((((((7.7454501427834140764e-4 * r + 0.0227238449892691845833) * r
                + 0.24178072517745061177) * r + 1.27045825245236838258) * r
                + 3.64784832476320460504) * r + 5.7694972214606914055) * r
                + 4.6303378461565452959) * r + 1.42343711074968357734)
       / (((((((1.05075007164441684324e-9 * r + 5.475938084995344946e-4) * r
                + 0.0151986665636164571966) * r + 0.14810397642748007459) * r
                + 0.68976733498510000455) * r + 1.6763848301838038494) * r
                + 2.05319162663775882187) * r + 1.0);
  else
    r := r - 5.0;
    r := (((((((2.01033439929228813265e-7 * r + 2.71155556874348757815e-5) * r
                + 0.0012426609473880784386) * r + 0.026532189526576123093) * r
                + 0.29656057182850489123) * r + 1.7848265399172913358) * r
                + 5.4637849111641143699) * r + 6.6579046435011037772)
       / (((((((2.04426310338993978564e-15 * r + 1.4215117583164458887e-7) * r
                + 1.8463183175100546818e-5) * r + 7.868691311456132591e-4) * r
                + 0.0148753612908506148525) * r + 0.13692988092273580531) * r
                + 0.59983220655588793769) * r + 1.0);
  end if;

  if q < 0 then return -r; end if;
  return r;
end;
$$;

comment on function public.norm_s_inv(double precision) is
  'Inversa da normal padrão (Wichura AS241). Equivale a NORM.S.INV do Excel.';

revoke all on function public.norm_s_inv(double precision) from public;
revoke all on function public.norm_s_inv(double precision) from anon;
revoke all on function public.norm_s_inv(double precision) from authenticated;
grant execute on function public.norm_s_inv(double precision) to authenticated;

-- Asserção de migration: se o Z não bate, todo estoque de segurança do sistema
-- está errado e é melhor o deploy falhar aqui do que a compra sair torta.
-- Os dois primeiros são idênticos bit a bit ao Excel; em 0,90 o AS241 devolve
-- ...446006 e o Excel ...446004 — 1 ULP, irrelevante depois do CEIL, mas
-- registrado aqui para que a diferença seja uma decisão e não uma surpresa.
do $$
declare
  a double precision := public.norm_s_inv(0.975);
  b double precision := public.norm_s_inv(0.95);
  c double precision := public.norm_s_inv(0.90);
begin
  if a <> 1.9599639845400536 then
    raise exception 'norm_s_inv(0.975) = %, esperado 1.9599639845400536', a;
  end if;
  if b <> 1.6448536269514715 then
    raise exception 'norm_s_inv(0.95) = %, esperado 1.6448536269514715', b;
  end if;
  if abs(c - 1.2815515655446004) > 1e-15 then
    raise exception 'norm_s_inv(0.90) = %, esperado ~1.2815515655446004', c;
  end if;
  if abs(public.norm_s_inv(0.5)) > 1e-16 then
    raise exception 'norm_s_inv(0.5) deveria ser 0, veio %', public.norm_s_inv(0.5);
  end if;
  if abs(public.norm_s_inv(0.999) - 3.090232306167813) > 1e-12 then
    raise exception 'norm_s_inv(0.999) = %', public.norm_s_inv(0.999);
  end if;
end $$;
