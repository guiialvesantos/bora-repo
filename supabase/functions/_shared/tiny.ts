// Cliente do Tiny/Olist — API v2 (só existe token v2 hoje).
//
// Duas coisas que a v2 faz diferente de qualquer API REST comum:
//
// 1. O token vai na query string / corpo do form, não em Authorization.
// 2. Erro é `retorno.status === 'Erro'` dentro de um corpo 200. O HTTP status
//    quase nunca muda — checar `res.ok` sozinho deixaria passar erro lógico
//    (token inválido, "excesso de registros") como se fosse sucesso.
//
// A interface (`TinyConnection`, `tinyCall`) é o ponto de troca para v3 depois:
// quem chama não sabe que é form-encoded nem que token vai na query.

export interface TinyConnection {
  token: string
}

export class TinyApiError extends Error {
  codigo: string | null
  constructor(message: string, codigo: string | null) {
    super(message)
    this.name = 'TinyApiError'
    this.codigo = codigo
  }
}

/** "Excesso de registros" — quem chama sabe estreitar a janela e tentar de novo. */
export class TinyTooManyRecordsError extends TinyApiError {}

/**
 * Bloqueio próprio do Tiny por excesso de chamadas — vem como erro lógico
 * (retorno.status "Erro", HTTP 200), não HTTP 429, então não dá pra detectar
 * pelo status code. Mensagem real observada em produção: "API Bloqueada -
 * Excedido o número de acessos a API, aguarde alguns minutos e tente
 * novamente". Tratado como o 429: quem chama recua o bucket e tenta de novo,
 * em vez de encerrar o job com erro definitivo.
 */
export class TinyRateLimitedError extends TinyApiError {}

const BASE = 'https://api.tiny.com.br/api2'

/**
 * Limite real (requisições/minuto) do plano da conta, documentado em
 * https://tiny.com.br/api-docs/api2-limites-api — a v2 devolve no header
 * `x-limit-api` de TODA resposta, sucesso ou erro. Não é chute: 20 (planos
 * descontinuados) / 30 (Crescer) / 60 (Evoluir) / 120 (Potencializar) por
 * minuto. Módulo-level porque uma invocação do worker processa um job por
 * vez, sequencial — não há chamada concorrente disputando este valor.
 */
export let lastKnownLimitPerMinute: number | null = null

// deno-lint-ignore no-explicit-any
export async function tinyCall(conn: TinyConnection, method: string, params: Record<string, string> = {}): Promise<any> {
  const body = new URLSearchParams({ token: conn.token, formato: 'json', ...params })
  const res = await fetch(`${BASE}/${method}.php`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body,
  })

  const limitHeader = res.headers.get('x-limit-api')
  if (limitHeader) {
    const parsed = Number(limitHeader)
    if (Number.isFinite(parsed) && parsed > 0) lastKnownLimitPerMinute = parsed
  }

  if (res.status === 429) throw new TinyApiError('Limite de requisições do Tiny excedido (HTTP 429)', '429')
  if (!res.ok) throw new TinyApiError(`Tiny respondeu HTTP ${res.status}`, null)

  // deno-lint-ignore no-explicit-any
  const data = (await res.json()) as any
  const retorno = data?.retorno
  if (!retorno) throw new TinyApiError('Resposta do Tiny sem campo "retorno"', null)

  if (retorno.status === 'Erro') {
    const erro = retorno.erros?.[0]?.erro ?? 'Erro desconhecido do Tiny'
    const codigo = retorno.codigo_erro ?? null
    if (codigo === '21') throw new TinyTooManyRecordsError(erro, codigo)
    if (/bloquead/i.test(erro) && /acesso/i.test(erro)) throw new TinyRateLimitedError(erro, codigo)
    throw new TinyApiError(erro, codigo)
  }

  return retorno
}

/** `dd/mm/yyyy`, o único formato que a v2 aceita em filtro de data. */
export function toTinyDate(d: Date): string {
  const p = (n: number) => String(n).padStart(2, '0')
  return `${p(d.getUTCDate())}/${p(d.getUTCMonth() + 1)}/${d.getUTCFullYear()}`
}

// ---------------------------------------------------------------- produtos

export interface TinyProdutoResumo {
  id: string
  codigo: string | null
  nome: string
  situacao: string
}

/** `produtos.pesquisa` — paginado, ~100 por página. */
export async function tinyListarProdutos(conn: TinyConnection, pagina: number): Promise<{
  produtos: TinyProdutoResumo[]
  numeroPaginas: number
}> {
  const retorno = await tinyCall(conn, 'produtos.pesquisa', { pagina: String(pagina) })
  // deno-lint-ignore no-explicit-any
  const produtos = (retorno.produtos ?? []).map((p: any) => ({
    id: String(p.produto.id),
    codigo: p.produto.codigo || null,
    nome: p.produto.nome,
    situacao: p.produto.situacao,
  }))
  return { produtos, numeroPaginas: Number(retorno.numero_paginas ?? 1) }
}

export interface TinyProdutoDetalhe {
  id: string
  codigo: string | null
  nome: string
  preco: number
  precoCusto: number
  imageUrl: string | null
}

/** `produto.obter` — preço de venda e custo, um produto por vez. */
export async function tinyObterProduto(conn: TinyConnection, id: string): Promise<TinyProdutoDetalhe> {
  const retorno = await tinyCall(conn, 'produto.obter', { id })
  const p = retorno.produto
  // Foto: `anexos` traz `{anexo: url}`; `imagens_externas` traz `{imagem: {url}}`.
  // deno-lint-ignore no-explicit-any
  const anexo = (p.anexos ?? []).find((a: any) => typeof a?.anexo === 'string' && a.anexo)
  // deno-lint-ignore no-explicit-any
  const externa = (p.imagens_externas ?? []).find((i: any) => typeof i?.imagem_externa?.url === 'string' && i.imagem_externa.url)
  return {
    id: String(p.id),
    codigo: p.codigo || null,
    nome: p.nome,
    preco: Number(p.preco ?? 0),
    precoCusto: Number(p.preco_custo ?? 0),
    imageUrl: anexo?.anexo ?? externa?.imagem_externa?.url ?? null,
  }
}

export interface TinyDeposito {
  externalName: string
  saldo: number
}

/** `produto.obter.estoque` — o split por depósito que a planilha não tinha. */
export async function tinyObterEstoque(conn: TinyConnection, id: string): Promise<TinyDeposito[]> {
  const retorno = await tinyCall(conn, 'produto.obter.estoque', { id })
  const depositos = retorno.produto?.depositos ?? []
  // deno-lint-ignore no-explicit-any
  return depositos.map((d: any) => ({
    externalName: d.deposito.nome,
    saldo: Number(d.deposito.saldo ?? 0),
  }))
}

/** Chamada leve só para validar o token na tela de conexão. */
export async function tinyTestConnection(conn: TinyConnection): Promise<void> {
  await tinyCall(conn, 'produtos.pesquisa', { pagina: '1' })
}

// ---------------------------------------------------------------- pedidos

export interface TinyPedidoResumo {
  id: string
  numero: string | null
  /** `dd/mm/yyyy` — a data local do pedido, exatamente o que vira `sold_on`. */
  dataPedido: string
  situacao: string
}

/**
 * `pedidos.pesquisa` — paginado (~100/página), filtrado por período.
 *
 * O list NÃO traz os itens do pedido; cada pedido exige um `pedido.obter`
 * (o N+1 que justifica a fila com orçamento). `codigo_erro 21` (excesso de
 * registros) sobe como `TinyTooManyRecordsError` — quem chama estreita a
 * janela de datas e tenta de novo.
 */
export async function tinyPesquisarPedidos(
  conn: TinyConnection,
  dataInicial: string,
  dataFinal: string,
  pagina: number,
): Promise<{ pedidos: TinyPedidoResumo[]; numeroPaginas: number }> {
  let retorno
  try {
    retorno = await tinyCall(conn, 'pedidos.pesquisa', {
      dataInicial,
      dataFinal,
      pagina: String(pagina),
    })
  } catch (e) {
    // Janela sem vendas vem como erro lógico — em produção a mensagem é
    // "A consulta não retornou registros" (há variantes com "nenhum
    // registro"). Para o sync isso é resultado normal, não falha.
    if (e instanceof TinyApiError && !(e instanceof TinyTooManyRecordsError) &&
        !(e instanceof TinyRateLimitedError) &&
        /nenhum registro|n[aã]o retornou registros/i.test(e.message)) {
      return { pedidos: [], numeroPaginas: 0 }
    }
    throw e
  }
  // deno-lint-ignore no-explicit-any
  const pedidos = (retorno.pedidos ?? []).map((p: any) => ({
    id: String(p.pedido.id),
    numero: p.pedido.numero != null ? String(p.pedido.numero) : null,
    dataPedido: String(p.pedido.data_pedido),
    situacao: String(p.pedido.situacao ?? ''),
  }))
  return { pedidos, numeroPaginas: Number(retorno.numero_paginas ?? 1) }
}

export interface TinyPedidoItem {
  codigo: string | null
  quantidade: number
  valorUnitario: number
}

export interface TinyPedidoDetalhe {
  id: string
  numero: string | null
  dataPedido: string
  situacao: string
  itens: TinyPedidoItem[]
}

/** `pedido.obter` — o detalhe com itens, um pedido por vez. */
export async function tinyObterPedido(conn: TinyConnection, id: string): Promise<TinyPedidoDetalhe> {
  const retorno = await tinyCall(conn, 'pedido.obter', { id })
  const p = retorno.pedido
  // deno-lint-ignore no-explicit-any
  const itens = (p.itens ?? []).map((i: any) => ({
    codigo: i.item.codigo || null,
    quantidade: Number(i.item.quantidade ?? 0),
    valorUnitario: Number(i.item.valor_unitario ?? 0),
  }))
  return {
    id: String(p.id),
    numero: p.numero != null ? String(p.numero) : null,
    dataPedido: String(p.data_pedido),
    situacao: String(p.situacao ?? ''),
    itens,
  }
}
