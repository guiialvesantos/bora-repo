-- ============================================================================
-- 0013 — foto do produto
-- ----------------------------------------------------------------------------
-- URL da imagem principal vinda do Tiny (anexos do produto, v2 e v3). É só
-- exibição nas listas (Produtos, Pedido de Compra, Curva ABC) — nenhum
-- cálculo depende dela, por isso text nullable sem índice.
-- ============================================================================

alter table public.products
  add column if not exists image_url text;
