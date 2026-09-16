-- 0026_product_variations — o vínculo pai ↔ variação, vindo do ERP.
--
-- `products` sempre foi plana. Para a All Out isso é uma perda real: o catálogo
-- dela é grade (uma bermuda × 5 cores × 5 tamanhos = 25 linhas), e quem compra
-- decide no nível do produto, não no da grade. Sem o vínculo, a tela de
-- produtos lista 25 linhas soltas e a demanda do produto não existe em lugar
-- nenhum.
--
-- Por que vem do Tiny e não do nome: o padrão "<nome do pai> - <variação>"
-- parece resolver (casa 1.749 de 1.780 na All Out) e erra nos DOIS sentidos.
-- Erra para menos nas 25 variações do "Top Feminino All Out Run Training
-- MPRun", que na API têm `tipoVariacao='V'` e `produtoPai = null` — o vínculo
-- está quebrado no ERP, e adivinhar pelo nome inventaria um pai que não existe.
-- E erra para mais em produtos avulsos com traço no nome ("Blush All in One
-- FPS30 4,5g - Coral by Ana Runner"), que viram filhos de nada.
--
-- Um agrupamento adivinhado soma demanda errada sem avisar. Este é o tipo de
-- número em que alguém gasta dinheiro, então ele vem do ERP ou não vem.

alter table public.products
  -- Guardado já no formato de `external_id` ("tiny-953829968") para casar
  -- direto, sem prefixo remontado em cada consulta.
  add column if not exists parent_external_id text,
  -- 'N' normal · 'P' pai · 'V' variação. É o `tipoVariacao` do Tiny, cru de
  -- propósito: traduzir aqui só criaria um segundo vocabulário para conferir.
  -- NULL = empresa em v2 (Triana), que não tem o conceito.
  add column if not exists variation_type text;

alter table public.products
  drop constraint if exists products_variation_type_check;
alter table public.products
  add constraint products_variation_type_check
  check (variation_type is null or variation_type in ('N', 'P', 'V'));

-- O uso é sempre "me dê os filhos deste pai, nesta empresa".
create index if not exists products_parent_idx
  on public.products (company_id, parent_external_id)
  where parent_external_id is not null;
