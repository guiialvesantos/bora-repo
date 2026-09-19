// ============================================================================
// _shared/trier — tradução dos DTOs da API SGF (Trier Sistemas) para o modelo
// do BoraRepô. Funções puras: nada aqui faz HTTP nem toca no banco.
// ----------------------------------------------------------------------------
// O conector instalado na farmácia é um cano burro: ele pagina a API local e
// empurra o JSON **cru** da Trier para o `trier-ingest`. Toda a tradução mora
// aqui, do lado do servidor, de propósito — quando o mapeamento de um campo
// estiver errado (e vai estar: o spec é 1.5.14 e já tem divergência declarada),
// o conserto é um deploy de Edge Function, não uma atualização de binário em
// duzentos computadores de farmácia que ninguém liga no fim de semana.
//
// Referência: docs/trier/openapi-sgf-v1.5.14.json (OpenAPI 3.0.1, 101 rotas).
// ============================================================================

export const TRIER_SOURCE = 'trier_sgf'

/** Prefixo de `products.external_id`. Mesmo formato do Tiny (`tiny-<id>`). */
export const trierProductExternalId = (codigo: number | string) => `trier-${codigo}`

// ---------------------------------------------------------------------------
// DTOs da Trier — só os campos que o BoraRepô lê. O conector manda o objeto
// inteiro; campo que não está aqui é simplesmente ignorado.
// ---------------------------------------------------------------------------

export interface TrierProduto {
  codigo: number
  nome?: string | null
  valorVenda?: number | null
  valorCusto?: number | null
  valorCustoMedio?: number | null
  quantidadeEstoque?: number | null
  unidade?: string | null
  codigoBarras?: number | string | null
  nomeLaboratorio?: string | null
  nomeDepartamento?: string | null
  nomeGrupo?: string | null
  nomeCategoria?: string | null
  nomeClassificacao?: string | null
  nomePrincipioAtivo?: string | null
  nomTipo?: string | null
  produtoManipulado?: string | null
  ativo?: boolean | null
  tags?: string[] | null
}

export interface TrierEstoque {
  codigoProduto: number
  quantidadeEstoque?: number | null
  valorCustoMedio?: number | null
  dataUltimaEntrada?: string | null
  valorUltimaEntrada?: number | null
}

export interface TrierVendaItem {
  codigoProduto?: number | null
  quantidadeProdutos?: number | null
  valorTotalLiquido?: number | null
  vlrUnitario?: number | null
  numSequencial?: number | null
}

export interface TrierVenda {
  numeroNota?: number | null
  numeroNotaOrigem?: number | null
  tipoCancelamento?: string | null
  dataEmissao?: string | null
  horaEmissao?: string | null
  codFilial?: number | null
  itens?: TrierVendaItem[] | null
}

export interface TrierItemPedido {
  numeroPedido?: number | null
  numeroSequencialItem?: number | null
  dataEmissao?: string | null
  codigoFornecedor?: number | null
  nomeFornecedor?: string | null
  codigoProduto?: number | null
  nomeProduto?: string | null
  fatorCompra?: number | null
  quantidadeProdutos?: number | null
  valorUnitario?: number | null
  transmitido?: boolean | null
}

export interface TrierCompraItem {
  codigoProduto?: number | null
  quantidadeProdutos?: number | null
  fatorCompra?: number | null
  valorUnitario?: number | null
  valorUnitarioLiquido?: number | null
}

export interface TrierCompra {
  dataEntrada?: string | null
  numeroNotaFiscal?: number | null
  codigoFornecedor?: number | null
  itens?: TrierCompraItem[] | null
}

// ---------------------------------------------------------------------------
// Datas
// ---------------------------------------------------------------------------

/**
 * A parte `yyyy-MM-dd` de um ISO 8601 da Trier. Recorte de string, não `new
 * Date(...)`: o SGF roda no horário da farmácia e em geral devolve a data sem
 * fuso ("2026-09-19T14:32:00"); passar isso por `Date` faria o runtime assumir
 * UTC e, em São Paulo, jogar toda venda da noite para o dia seguinte — o que
 * desloca o bucket semanal e, por tabela, o desvio-padrão do motor.
 */
export function trierDateOnly(value: string | null | undefined): string | null {
  if (!value) return null
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(String(value).trim())
  return m ? `${m[1]}-${m[2]}-${m[3]}` : null
}

/**
 * `dataEmissao` e `horaEmissao` chegam como dois campos separados, ambos
 * declarados `date-time` no spec — provavelmente o mesmo instante partido em
 * dois, mas isso só se confirma com dado real. Enquanto não confirma, a hora é
 * usada SÓ se for reconhecível; o fallback é meio-dia, que não escorrega de dia
 * em nenhum fuso do Brasil. `sold_on` é quem manda no motor de qualquer forma.
 */
export function trierOrderedAt(
  dataEmissao: string | null | undefined,
  horaEmissao?: string | null,
): string | null {
  const day = trierDateOnly(dataEmissao)
  if (!day) return null
  const hm = horaEmissao ? /(\d{2}):(\d{2})(?::(\d{2}))?/.exec(String(horaEmissao)) : null
  const time = hm ? `${hm[1]}:${hm[2]}:${hm[3] ?? '00'}` : '12:00:00'
  return `${day}T${time}-03:00`
}

// ---------------------------------------------------------------------------
// Produto
// ---------------------------------------------------------------------------

const clean = (v: unknown) => {
  const s = typeof v === 'string' ? v.trim() : ''
  return s === '' ? null : s
}

/**
 * Caminho de categoria em dois níveis. `dashboard_sales_by_category` (0033)
 * parte a string em `->` para montar o agrupamento — é esse o contrato, não o
 * `>>` que o Tiny v3 devolve por acaso dentro do próprio nome.
 *
 * Departamento → Grupo é a hierarquia real da farmácia ("Medicamentos ->
 * Analgésicos"). `nomeCategoria` ("Uso Adulto") e `nomeClassificacao` ("Tarja
 * Amarela") são eixos ORTOGONAIS a esse, não níveis abaixo dele: viram tag.
 */
function categoryPath(p: TrierProduto): string | null {
  const dep = clean(p.nomeDepartamento)
  const grp = clean(p.nomeGrupo)
  if (dep && grp) return `${dep} -> ${grp}`
  return dep ?? grp
}

/**
 * As tags carregam o que é específico de farmácia e não tem coluna própria.
 *
 * `principio:` é a mais importante das quatro: em medicamento a demanda é
 * SUBSTITUÍVEL entre genéricos do mesmo princípio ativo — quem não achou a
 * dipirona da marca A leva a da marca B, e a venda não se perde. O motor de
 * hoje calcula σ por SKU e, sem essa chave, lê troca de marca como volatilidade
 * de demanda. A tag não conserta o motor; ela é o que torna o conserto possível
 * depois, sem um novo sync.
 */
function productTags(p: TrierProduto): string[] {
  const tags = new Set<string>()
  for (const t of p.tags ?? []) {
    const v = clean(t)
    if (v) tags.add(v)
  }
  const principio = clean(p.nomePrincipioAtivo)
  if (principio) tags.add(`principio:${principio}`)
  const classificacao = clean(p.nomeClassificacao)
  if (classificacao) tags.add(`tarja:${classificacao}`)
  const categoria = clean(p.nomeCategoria)
  if (categoria) tags.add(`uso:${categoria}`)
  const tipo = clean(p.nomTipo)
  if (tipo) tags.add(`tipo:${tipo}`)
  if (clean(p.produtoManipulado) === 'S') tags.add('manipulado')
  return [...tags]
}

/**
 * Produto → linha de `products`.
 *
 * O SKU é `codigo`, não `codigoBarras`. O spec declara `codigoBarras` como
 * `integer int64`, e EAN é uma STRING de dígitos: o EAN-13 "0012345678905"
 * vira o número 12345678905 e perde o zero à esquerda para sempre. Como o SKU
 * é a chave que casa venda com produto e com item em trânsito, um zero perdido
 * não é cosmético — é uma venda que deixa de casar. O `codigo` reduzido é
 * inteiro por natureza e é a PK real do lado da Trier.
 *
 * `cmv` prefere `valorCustoMedio`: custo médio é o que o motor quer (a margem
 * que o negócio realmente teve), e o `valorCusto` de cadastro costuma ficar
 * parado no valor da primeira entrada. Zero vira null — no BoraRepô "zero" e
 * "não informado" são coisas diferentes, e é a segunda que aciona o CMV
 * estimado.
 */
export function mapProduto(p: TrierProduto, companyId: string) {
  const cmv = p.valorCustoMedio ?? p.valorCusto ?? null
  return {
    company_id: companyId,
    external_id: trierProductExternalId(p.codigo),
    sku: String(p.codigo),
    name: clean(p.nome) ?? `Produto ${p.codigo}`,
    sale_price: p.valorVenda ?? 0,
    cmv: cmv && cmv > 0 ? cmv : null,
    is_active: p.ativo !== false,
    category: categoryPath(p),
    brand: clean(p.nomeLaboratorio),
    tags: productTags(p),
  }
}

// ---------------------------------------------------------------------------
// Venda
// ---------------------------------------------------------------------------

/**
 * Venda → cabeçalho + itens.
 *
 * **Cancelamento entra como linha NEGATIVA**, não como `shadow`. É a diferença
 * que importa neste mercado: `/venda/cancelamento` é um documento próprio, com
 * `tipoCancelamento` (D=devolução, E=estorno), `numeroNotaOrigem` apontando para
 * a venda original e itens com quantidade PRÓPRIA. Devolver 1 de 3 caixas é
 * rotina em farmácia, e o booleano `shadow` do modelo do Tiny só sabe apagar a
 * venda inteira — apagaria as outras 2 caixas junto. Quantidade negativa soma
 * certo: `sum(qty)` da semana entrega a demanda líquida, que é o que o motor
 * precisa comprar.
 *
 * O preço é `valorTotalLiquido / quantidade`, não `vlrUnitario`: o líquido já
 * tem o desconto aplicado, e desconto de gôndola em farmácia é a regra, não a
 * exceção. A receita por SKU que alimenta a curva ABC tem que ser o dinheiro
 * que entrou no caixa.
 */
export function mapVenda(v: TrierVenda, companyId: string, isCancellation = false) {
  const soldOn = trierDateOnly(v.dataEmissao)
  if (!soldOn || v.numeroNota == null) return null

  const filial = v.codFilial ?? 0
  const externalId = isCancellation
    ? `trier-canc-${filial}-${v.numeroNota}`
    : `trier-${filial}-${v.numeroNota}`

  // D (devolução) e E (estorno) abatem igual — a diferença entre os dois é
  // fiscal, não de demanda. O que muda a conta é o SINAL, e ele é o mesmo.
  const sign = isCancellation ? -1 : 1

  const items = (v.itens ?? [])
    .filter((i) => i.codigoProduto != null && i.quantidadeProdutos != null)
    .map((i) => {
      const qty = Number(i.quantidadeProdutos ?? 0)
      const liquido = i.valorTotalLiquido
      const unit = liquido != null && qty !== 0
        ? Math.abs(liquido / qty)
        : (i.vlrUnitario ?? null)
      return {
        company_id: companyId,
        sku: String(i.codigoProduto),
        qty: sign * Math.abs(qty),
        unit_price: unit,
        sold_on: soldOn,
        shadow: false,
      }
    })

  return {
    order: {
      company_id: companyId,
      external_id: externalId,
      // Venda de balcão de farmácia. O enum `sales_channel` já tem 'loja' — a
      // Trier não precisou de canal novo.
      channel: 'loja' as const,
      number: String(v.numeroNota),
      status: isCancellation ? `cancelamento ${v.tipoCancelamento ?? ''}`.trim() : 'venda',
      ordered_at: trierOrderedAt(v.dataEmissao, v.horaEmissao) ?? `${soldOn}T12:00:00-03:00`,
      sold_on: soldOn,
      items_fetched: true,
      shadow: false,
    },
    items,
  }
}

// ---------------------------------------------------------------------------
// Pedido de compra (em trânsito)
// ---------------------------------------------------------------------------

/**
 * `/pedido/itens/resumido` devolve ITENS soltos, não pedidos: o cabeçalho
 * (número, data, fornecedor) vem repetido em cada linha. Agrupar por
 * `numeroPedido` reconstrói o pedido.
 *
 * `fatorCompra` é o múltiplo de caixa fechada — 20 unidades por caixa significa
 * que pedir 25 é impossível. Hoje o comprador corrige isso na mão na tela de
 * pedido; a Trier entrega o número, então ele é guardado por item para o dia em
 * que o motor arredondar sozinho.
 */
export function groupItensPedido(rows: TrierItemPedido[], companyId: string) {
  const byOrder = new Map<string, {
    order: Record<string, unknown>
    items: Record<string, unknown>[]
  }>()

  for (const r of rows) {
    if (r.numeroPedido == null || r.codigoProduto == null) continue
    const key = String(r.numeroPedido)
    let entry = byOrder.get(key)
    if (!entry) {
      entry = {
        order: {
          company_id: companyId,
          source: TRIER_SOURCE,
          external_id: key,
          status: 'open',
          supplier: clean(r.nomeFornecedor),
          ordered_on: trierDateOnly(r.dataEmissao),
          eta_on: null,
          note: `Pedido ${key} (Trier)`,
        },
        items: [],
      }
      byOrder.set(key, entry)
    }
    entry.items.push({
      company_id: companyId,
      sku: String(r.codigoProduto),
      qty_ordered: Number(r.quantidadeProdutos ?? 0),
      qty_received: 0,
      eta_on: null,
      // O código do fornecedor viaja em `category` porque é a única coluna
      // livre de `purchase_order_items` — e é ele que fecha a baixa por
      // recebimento (ver `matchReceipt`). Renomear a coluna seria mais honesto;
      // criar uma coluna nova para um provider só, não.
      category: r.codigoFornecedor != null ? `fornecedor:${r.codigoFornecedor}` : null,
    })
  }

  return [...byOrder.values()]
}

/**
 * Chave de baixa do trânsito por recebimento.
 *
 * Esta é a lacuna conhecida do modelo da Trier: `CompraIntegracaoDto` (a nota
 * que entrou) **não tem `numeroPedido`**. Não existe o vínculo "esta caixa que
 * chegou é daquele pedido". Sobram três dimensões que aparecem dos DOIS lados:
 * fornecedor, produto e ordem no tempo.
 *
 * A regra implementada é FIFO por (fornecedor, produto): a compra que chega
 * abate os pedidos abertos daquele fornecedor para aquele produto, do mais
 * antigo para o mais novo, até acabar a quantidade recebida.
 *
 * O erro que ela pode cometer é conhecido e é o menos caro: se a farmácia tem
 * dois pedidos abertos do mesmo item para o mesmo fornecedor, o FIFO pode
 * baixar o pedido errado dos dois — mas o TOTAL em trânsito fica certo, e é o
 * total que o motor lê (`sum(qty_open)`). O erro caro seria o oposto: não
 * baixar nada, deixar trânsito fantasma em pé e o motor parar de comprar um
 * item que já acabou na prateleira.
 */
export function matchReceipt(item: TrierCompraItem, codigoFornecedor: number | null | undefined) {
  return {
    sku: item.codigoProduto != null ? String(item.codigoProduto) : null,
    qty: Number(item.quantidadeProdutos ?? 0),
    supplierTag: codigoFornecedor != null ? `fornecedor:${codigoFornecedor}` : null,
  }
}
