-- 0038_trier — integração nativa com a Trier Sistemas (API SGF), via conector
-- instalado na farmácia.
--
-- ----------------------------------------------------------------------------
-- Por que existe um CONECTOR e não só uma Edge Function
-- ----------------------------------------------------------------------------
-- A API SGF é ON-PREMISE. A própria documentação da Trier declara
-- `BASE_URL: http://localhost:4647/sgfpod1` e instrui a trocar `localhost`
-- pelo IP do servidor da farmácia. Ou seja: o endereço só existe dentro da
-- rede local da loja, sem TLS.
--
-- As duas saídas eram:
--
--   (a) a farmácia abrir a porta 4647 no roteador (NAT/Virtual Server) e
--       contratar IP fixo ou DDNS, como a Trier documenta; ou
--   (b) um processo rodando DENTRO da farmácia que lê em loopback e empurra
--       para fora por HTTPS.
--
-- Esta migration implementa (b). (a) exporia um ERP inteiro em HTTP puro na
-- internet — cadastro de cliente e histórico de venda de medicamento, que é
-- dado sensível de saúde — e ainda assim não funcionaria em link com CGNAT,
-- comum no varejo pequeno: sem IP público não há porta para redirecionar.
--
-- Consequência importante do desenho: **o token da Trier nunca sai da loja**.
-- Ele fica no arquivo de configuração do conector, ao lado do servidor SGF.
-- O que trafega até aqui é uma chave emitida por nós, revogável por nós, que
-- só sabe fazer uma coisa — escrever dados desta empresa.
--
-- ----------------------------------------------------------------------------
-- Por que UM conector por loja
-- ----------------------------------------------------------------------------
-- O SGF roda por loja. `EstoqueIntegracaoDto` não tem campo de filial: o
-- estoque que aquele servidor devolve É o estoque daquela loja e de mais
-- nenhuma. Amarrar cada conector a um `warehouse` resolve a rede de farmácias
-- sem inventar nada — o motor já soma depósitos com `include_in_available`, e
-- excluir uma loja do disponível passa a ser um clique, não um deploy.

create table public.trier_connectors (
  id            uuid primary key default gen_random_uuid(),
  company_id    uuid not null references public.companies (id) on delete cascade,
  connection_id uuid not null references public.integration_connections (id) on delete cascade,
  -- Como o humano chama esta loja ("Farmácia Centro"). Aparece na tela de
  -- integrações e no rodapé de erro quando um conector para de dar sinal.
  label         text not null,
  -- Onde o estoque desta loja entra. `on delete restrict` de propósito: apagar
  -- o depósito sem desligar o conector deixaria o conector escrevendo no vazio.
  warehouse_id  uuid not null references public.warehouses (id) on delete restrict,
  -- Os 8 primeiros caracteres da chave, em claro. Serve só para o humano
  -- reconhecer QUAL chave está instalada naquele PC antes de revogar a errada.
  key_prefix    text not null,
  -- sha256 hex da chave inteira. A chave em si é mostrada UMA vez, na emissão,
  -- e não é recuperável — perdeu, emite outra. Mesmo princípio de
  -- `integration_secrets`: nada que autoriza escrita fica legível em repouso.
  key_hash      text not null unique,
  -- Onde cada tipo de sincronização parou, guardado AQUI e não no PC da
  -- farmácia. Reinstalar o conector (ou trocar o computador da loja) não pode
  -- disparar um backfill de 12 meses de venda do zero.
  cursors       jsonb not null default '{}'::jsonb,
  last_seen_at  timestamptz,
  last_version  text,
  last_error    text,
  revoked_at    timestamptz,
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now()
);

create index trier_connectors_company_idx on public.trier_connectors (company_id)
  where revoked_at is null;

create trigger trier_connectors_updated_at before update on public.trier_connectors
  for each row execute function public.set_updated_at();

-- ---------------------------------------------------------------- RLS

alter table public.trier_connectors enable row level security;

create policy trier_connectors_select on public.trier_connectors
  for select to authenticated
  using (public.has_company_role(company_id, 'owner', 'gestor'));

-- Grant COLUNA A COLUNA, omitindo `key_hash`. O hash de 32 bytes aleatórios não
-- é reversível, mas a casa não deixa credencial passar pelo navegador nem em
-- forma derivada — e a omissão obriga a UI a listar as colunas que usa, o que
-- faz um `select *` distraído falhar alto em vez de vazar em silêncio.
grant select (
  id, company_id, connection_id, label, warehouse_id, key_prefix, cursors,
  last_seen_at, last_version, last_error, revoked_at, created_at, updated_at
) on public.trier_connectors to authenticated;

-- Escrita é toda pelas Edge Functions (`trier-connect` emite/revoga,
-- `trier-ingest` carimba presença e cursor) — mesmo racional dos grants
-- tabela-a-tabela da 0009.
grant select, insert, update, delete on public.trier_connectors to service_role;

-- `trier-ingest` grava venda, compra e catálogo direto, como o
-- `tiny-sync-worker` já faz. As tabelas de venda e produto já receberam grant
-- na 0009/0011; as de compra ainda não — até aqui o trânsito vinha por RPC
-- SECURITY DEFINER (importação) ou pelo worker do Tiny, que usa as mesmas.
grant select, insert, update, delete on public.purchase_orders      to service_role;
grant select, insert, update, delete on public.purchase_order_items to service_role;
grant select, insert, update, delete on public.product_stock        to service_role;
grant select, insert, update, delete on public.warehouses           to service_role;
