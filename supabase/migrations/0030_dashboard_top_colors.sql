-- 0030_dashboard_top_colors — o que mais sai, por cor.
--
-- Não existe coluna de cor. Não existe tabela de atributo de variação. O Tiny
-- v3 devolve a variação como NOME COMPOSTO ("Legging Chicago - Preto - M") e é
-- só disso que se dispõe. Então a cor é EXTRAÍDA do nome, em dois passos:
--
--   1. tira-se o nome do pai como prefixo literal. Não por heurística de
--      separador: "Legging Chicago - Preto" tem um hífen no meio que não
--      separa nada. O pai é o gabarito, e ele existe (`parent_external_id`).
--      Em 1.738 das 1.763 variações da All Out o prefixo casa.
--   2. o resto é quebrado em ' - ' e os pedaços que PARECEM TAMANHO são
--      descartados. Descarta-se tamanho em vez de escolher a cor por posição
--      porque a ordem não é estável no catálogo real: existe
--      "... - Preto - M" e existe "... - G - Preto". O que sobra é a cor.
--
-- Os 25 casos em que o pai não está na base caem no `coalesce`: tudo depois do
-- primeiro ' - '. Pior que o gabarito, melhor que descartar a venda — e são
-- 1,4% das variações.
--
-- O que este método NÃO resolve, e é honesto dizer: nome de modelo escrito
-- como se fosse atributo ("CHICAGO", "SYDNEY") vaza como se fosse cor em uns
-- poucos SKUs. Só some quando o catálogo tiver atributo de verdade; inventar
-- uma lista de "palavras que são cor" trocaria um erro visível por um erro
-- silencioso, que come vendas legítimas de cores que ninguém lembrou de listar.
--
-- É relatório de VENDA: obedece a canal e período, não a depósito. Venda não
-- tem depósito — o pedido sai da empresa.

create or replace function public.dashboard_top_colors(
  _company_id uuid,
  _channel    text default null,
  _from       date default null,
  _to         date default null,
  _limit      int  default 8
)
returns jsonb
language plpgsql
stable
security definer
set search_path = public, pg_catalog
as $$
declare
  _result jsonb;
begin
  if not public.user_can_access_company(_company_id) then
    raise exception 'sem acesso a esta empresa' using errcode = '42501';
  end if;

  with
  variants as (
    select
      c.id,
      coalesce(
        case when p.name is not null and c.name like p.name || '%'
          then btrim(substr(c.name, length(p.name) + 1))
        end,
        case when position(' - ' in c.name) > 0
          then btrim(substr(c.name, position(' - ' in c.name) + 3))
        end
      ) as rest
    from public.products c
    left join public.products p
      on p.company_id = c.company_id
     and p.external_id = c.parent_external_id
    where c.company_id = _company_id
      and c.variation_type = 'V'
  ),
  -- Os pedaços que sobram, sem os que parecem tamanho. `with ordinality` para
  -- recompor "AZUL MARINHO" na ordem em que veio, e não "MARINHO AZUL".
  colored as (
    select
      v.id,
      upper(btrim(string_agg(t, ' ' order by o))) as color
    from variants v,
      lateral unnest(string_to_array(btrim(v.rest, ' -'), ' - ')) with ordinality as u(t, o)
    where v.rest is not null
      and btrim(t) <> ''
      and upper(btrim(t)) !~ '^(PP|P|M|G|GG|XG|XGG|XXG|U|UNICO|ÚNICO|TAM ?[0-9]+|[0-9]{1,3})$'
    group by v.id
  ),
  sold as (
    select
      colored.color,
      sum(i.qty)                as units,
      sum(i.qty * i.unit_price) as revenue
    from public.sales_order_items i
    join public.sales_orders o on o.id = i.order_id
    join colored on colored.id = i.product_id
    where i.company_id = _company_id
      and not i.shadow
      and not o.shadow
      and (_channel is null or o.channel::text = _channel)
      and (_from is null or i.sold_on >= _from)
      and (_to is null or i.sold_on <= _to)
    group by colored.color
    having sum(i.qty) > 0
  ),
  -- O total é de TODAS as cores, não só das que cabem na lista: a fatia de
  -- cada uma tem que ser a fatia do todo. Somar só as oito mostradas daria
  -- percentuais que fecham em 100% e mentem sobre a cauda.
  agg as (
    select
      coalesce(sum(units), 0)   as total_units,
      coalesce(sum(revenue), 0) as total_revenue,
      count(*)                  as total_colors
    from sold
  ),
  top as (
    select coalesce(jsonb_agg(x order by x.units desc), '[]'::jsonb) as list
    from (
      select color, units, revenue
      from sold
      order by units desc, color
      limit greatest(_limit, 1)
    ) x
  )
  select jsonb_build_object(
    'colors',        top.list,
    'total_units',   agg.total_units,
    'total_revenue', agg.total_revenue,
    'total_colors',  agg.total_colors,
    -- Para a tela distinguir "não vendeu nada no período" de "esta empresa
    -- não tem variação nenhuma" (a Triana não tem). São vazios diferentes e
    -- pedem frases diferentes.
    'has_variants',  exists (select 1 from variants)
  )
  into _result
  from agg, top;

  return _result;
end;
$$;

revoke all on function public.dashboard_top_colors(uuid, text, date, date, int) from public;
revoke all on function public.dashboard_top_colors(uuid, text, date, date, int) from anon;
revoke all on function public.dashboard_top_colors(uuid, text, date, date, int) from authenticated;
grant execute on function public.dashboard_top_colors(uuid, text, date, date, int) to authenticated;
