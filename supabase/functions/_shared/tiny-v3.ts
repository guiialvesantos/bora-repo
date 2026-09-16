// Cliente do Tiny/Olist — API v3 (aplicativo OAuth 2, authorization code).
//
// Diferenças estruturais em relação à v2 (`tiny.ts`):
//   - Bearer token em Authorization, não token em query string.
//   - Erro vem no HTTP status de verdade (401/403/429), não em `retorno.status`.
//   - O access token expira em ~4h e o REFRESH token em ~1 dia — quem guarda
//     os tokens precisa renovar com folga e persistir o refresh rotacionado,
//     senão a conexão morre e só reautorizando no navegador.
//
// O segredo criptografado da conexão v3 é um JSON único (`TinyV3Secret`):
// client_secret + tokens + validades. Timestamps de expiração também vão em
// `settings` (em claro) para o worker poder consultar sem descriptografar.

import { encryptSecret } from './crypto.ts'

export const TINY_V3_AUTH_BASE = 'https://accounts.tiny.com.br/realms/tiny/protocol/openid-connect'
export const TINY_V3_API_BASE = 'https://api.tiny.com.br/public-api/v3'

export interface TinyV3Secret {
  client_secret: string
  access_token: string | null
  refresh_token: string | null
  /** ISO — instante em que o access token expira. */
  access_expires_at: string | null
  /** ISO — instante em que o refresh token expira (a conexão morre aqui). */
  refresh_expires_at: string | null
}

export class TinyV3AuthError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'TinyV3AuthError'
  }
}

interface TokenResponse {
  access_token: string
  refresh_token: string
  expires_in: number
  refresh_expires_in: number
}

async function tokenRequest(form: Record<string, string>): Promise<TokenResponse> {
  const res = await fetch(`${TINY_V3_AUTH_BASE}/token`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams(form),
  })
  const body = await res.json().catch(() => null)
  if (!res.ok) {
    const detail = body?.error_description ?? body?.error ?? `HTTP ${res.status}`
    throw new TinyV3AuthError(`Tiny OAuth: ${detail}`)
  }
  if (!body?.access_token || !body?.refresh_token) {
    throw new TinyV3AuthError('Tiny OAuth: resposta de token sem access/refresh token')
  }
  return body as TokenResponse
}

export function buildAuthorizeUrl(clientId: string, redirectUri: string, state: string) {
  const q = new URLSearchParams({
    client_id: clientId,
    redirect_uri: redirectUri,
    scope: 'openid',
    response_type: 'code',
    state,
    // Sem isso o Keycloak do Tiny reaproveita a sessão SSO do navegador em
    // silêncio — a pessoa acha que reconectou, mas o token herda o login (e a
    // conta!) de horas atrás. Visto na prática: auth_time congelado entre
    // reconexões. prompt=login força a tela de credenciais toda vez.
    prompt: 'login',
  })
  return `${TINY_V3_AUTH_BASE}/auth?${q.toString()}`
}

export function exchangeCode(opts: {
  clientId: string
  clientSecret: string
  code: string
  redirectUri: string
}) {
  return tokenRequest({
    grant_type: 'authorization_code',
    client_id: opts.clientId,
    client_secret: opts.clientSecret,
    code: opts.code,
    redirect_uri: opts.redirectUri,
  })
}

export function refreshTokens(opts: {
  clientId: string
  clientSecret: string
  refreshToken: string
}) {
  return tokenRequest({
    grant_type: 'refresh_token',
    client_id: opts.clientId,
    client_secret: opts.clientSecret,
    refresh_token: opts.refreshToken,
  })
}

/** Converte a resposta de token em campos do segredo (expiração absoluta). */
export function tokensToSecretFields(tok: TokenResponse) {
  const now = Date.now()
  return {
    access_token: tok.access_token,
    refresh_token: tok.refresh_token,
    access_expires_at: new Date(now + tok.expires_in * 1000).toISOString(),
    refresh_expires_at: new Date(now + tok.refresh_expires_in * 1000).toISOString(),
  }
}

export class TinyV3ApiError extends Error {
  status: number
  constructor(message: string, status: number) {
    super(message)
    this.name = 'TinyV3ApiError'
    this.status = status
  }
}

/**
 * Limite por minuto do plano, lido do header `X-RateLimit-Limit` de toda
 * resposta v3 (30–140 rpm conforme o plano). Módulo-level pelo mesmo motivo
 * do v2: o worker processa um job por vez, sem concorrência.
 */
export let lastKnownV3LimitPerMinute: number | null = null

/**
 * GET na API v3. Os headers `X-RateLimit-*` vêm em toda resposta — devolvidos
 * junto para o chamador poder recuar sem chute (diferente do bucket adaptativo
 * da v2).
 */
// deno-lint-ignore no-explicit-any
export async function tinyV3Get(accessToken: string, path: string, params: Record<string, string> = {}): Promise<{ data: any; rateRemaining: number | null }> {
  const q = new URLSearchParams(params)
  const url = `${TINY_V3_API_BASE}${path}${q.size ? `?${q.toString()}` : ''}`
  const res = await fetch(url, { headers: { Authorization: `Bearer ${accessToken}` } })
  const remainingHeader = res.headers.get('X-RateLimit-Remaining')
  const rateRemaining = remainingHeader != null && Number.isFinite(Number(remainingHeader))
    ? Number(remainingHeader)
    : null
  const limitHeader = res.headers.get('X-RateLimit-Limit')
  if (limitHeader != null) {
    const parsed = Number(limitHeader)
    if (Number.isFinite(parsed) && parsed > 0) lastKnownV3LimitPerMinute = parsed
  }
  if (!res.ok) {
    const body = await res.text().catch(() => '')
    throw new TinyV3ApiError(`Tiny v3 ${path}: HTTP ${res.status}${body ? ` — ${body.slice(0, 200)}` : ''}`, res.status)
  }
  return { data: await res.json(), rateRemaining }
}

// ---------------------------------------------------------------------------
// Renovação com persistência — compartilhada entre tiny-connect (oauth_test)
// e o worker (manutenção de cron). Renova com 30 min de folga; o refresh
// token rotacionado é regravado NA HORA: perder um refresh token novo por
// não persistir é a única forma de matar a conexão sem o usuário errar nada.
// ---------------------------------------------------------------------------

export interface TinyV3ConnRow {
  id: string
  settings: Record<string, unknown>
}

/**
 * Garante access token válido, renovando e persistindo se preciso.
 * Lança `TinyV3AuthError` se o refresh token já morreu (reautorizar é a
 * única saída — não há o que tentar de novo).
 */
export async function ensureFreshAccess(
  // deno-lint-ignore no-explicit-any
  admin: any,
  cryptoKey: CryptoKey,
  conn: TinyV3ConnRow,
  secret: TinyV3Secret,
  marginMs = 30 * 60_000,
): Promise<TinyV3Secret> {
  const now = Date.now()
  if (
    secret.access_token &&
    secret.access_expires_at &&
    new Date(secret.access_expires_at).getTime() - now > marginMs
  ) {
    return secret
  }

  if (
    !secret.refresh_token ||
    (secret.refresh_expires_at && new Date(secret.refresh_expires_at).getTime() <= now)
  ) {
    throw new TinyV3AuthError('Autorização do Tiny expirou — reconecte em Integrações')
  }

  const clientId = String(conn.settings?.client_id ?? '')
  const tokens = tokensToSecretFields(await refreshTokens({
    clientId,
    clientSecret: secret.client_secret,
    refreshToken: secret.refresh_token,
  }))

  const updated: TinyV3Secret = { client_secret: secret.client_secret, ...tokens }
  const enc = await encryptSecret(cryptoKey, JSON.stringify(updated))
  const { error: secErr } = await admin.from('integration_secrets').upsert({
    connection_id: conn.id,
    ciphertext: enc.ciphertext,
    iv: enc.iv,
    key_version: enc.key_version,
    updated_at: new Date().toISOString(),
  })
  if (secErr) throw secErr

  const { error: connErr } = await admin.from('integration_connections').update({
    settings: {
      ...conn.settings,
      access_expires_at: tokens.access_expires_at,
      refresh_expires_at: tokens.refresh_expires_at,
    },
    last_error: null,
  }).eq('id', conn.id)
  if (connErr) throw connErr

  return updated
}

// ---------------------------------------------------------------------------
// Fetchers de domínio — devolvem as MESMAS formas do cliente v2 (`tiny.ts`)
// para o worker tratar os dois protocolos com um único caminho de código.
//
// Paginação: a v3 é limit/offset (default 100, `paginacao.total` na resposta),
// não pagina/numero_paginas como a v2. Os fetchers traduzem: `pagina` N vira
// `offset = (N-1) * 100` e `numeroPaginas = ceil(total / 100)`.
// Datas: a v3 fala ISO `yyyy-MM-dd` dos dois lados — nada de dd/mm/yyyy.
// ---------------------------------------------------------------------------

const V3_PAGE_SIZE = 100

/** Situação de produto v3 (A/I/E) nos rótulos que a v2 usa. */
const V3_SITUACAO_PRODUTO: Record<string, string> = {
  A: 'Ativo', I: 'Inativo', E: 'Excluido',
}

/**
 * Situação de pedido v3 (inteiro) nos rótulos v2. O que importa para o motor
 * é `Cancelado` (vira shadow) — o resto é descritivo, gravado em
 * `sales_orders.status`.
 */
const V3_SITUACAO_PEDIDO: Record<number, string> = {
  0: 'Em aberto', 1: 'Faturado', 2: 'Cancelado', 3: 'Aprovado',
  4: 'Preparando envio', 5: 'Enviado', 6: 'Entregue', 7: 'Pronto para envio',
  8: 'Dados incompletos', 9: 'Não entregue',
}

export async function tinyV3ListarProdutos(accessToken: string, pagina: number): Promise<{
  produtos: { id: string; codigo: string | null; nome: string; situacao: string }[]
  numeroPaginas: number
}> {
  const { data } = await tinyV3Get(accessToken, '/produtos', {
    limit: String(V3_PAGE_SIZE),
    offset: String((pagina - 1) * V3_PAGE_SIZE),
  })
  // deno-lint-ignore no-explicit-any
  const produtos = (data?.itens ?? []).map((p: any) => ({
    id: String(p.id),
    codigo: p.sku || null,
    nome: String(p.descricao ?? ''),
    situacao: V3_SITUACAO_PRODUTO[String(p.situacao)] ?? String(p.situacao ?? ''),
  }))
  const total = Number(data?.paginacao?.total ?? produtos.length)
  return { produtos, numeroPaginas: Math.max(1, Math.ceil(total / V3_PAGE_SIZE)) }
}

export async function tinyV3ObterProduto(accessToken: string, id: string): Promise<{
  id: string
  codigo: string | null
  nome: string
  preco: number
  precoCusto: number
  imageUrl: string | null
  categoria: string | null
  marca: string | null
  /** `tipoVariacao` cru: 'N' normal · 'P' pai · 'V' variação. */
  tipoVariacao: string
  /** Id do produto pai, só na variação. */
  paiId: string | null
}> {
  const { data: p } = await tinyV3Get(accessToken, `/produtos/${id}`)
  // deno-lint-ignore no-explicit-any
  const anexos: any[] = Array.isArray(p?.anexos) ? p.anexos : []
  const image = anexos.find((a) => typeof a?.url === 'string' && a.url)
  return {
    id: String(p.id),
    codigo: p.sku || null,
    nome: String(p.descricao ?? ''),
    preco: Number(p.precos?.preco ?? 0),
    precoCusto: Number(p.precos?.precoCusto ?? 0),
    imageUrl: image?.url ?? null,
    // Uma variação PODE vir com `produtoPai: null` — a All Out tem 25 assim.
    // Não é erro de leitura: é o vínculo quebrado no próprio Tiny, e tem que
    // chegar quebrado no banco para a tela poder mostrar isso.
    tipoVariacao: ['N', 'P', 'V'].includes(String(p?.tipoVariacao))
      ? String(p.tipoVariacao)
      : 'N',
    paiId: p?.produtoPai?.id ? String(p.produtoPai.id) : null,
    // `caminhoCompleto` ("Vestuário >> Bermudas") diz mais que o nó folha.
    categoria: p.categoria?.caminhoCompleto || p.categoria?.nome || null,
    marca: p.marca?.nome || null,
  }
}

/**
 * `GET /produtos/{id}/tags` — as tags NÃO vêm no detalhe do produto; é uma
 * chamada própria (a 3ª por produto no sync). Devolve nomes normalizados
 * (lowercase, trim, sem duplicata) — é por tag que a All Out governa o
 * portfólio: core / drop / exit.
 */
export async function tinyV3ObterTagsProduto(accessToken: string, id: string): Promise<string[]> {
  const { data } = await tinyV3Get(accessToken, `/produtos/${id}/tags`)
  // deno-lint-ignore no-explicit-any
  const tags: any[] = Array.isArray(data?.tags) ? data.tags : []
  const nomes = tags
    .map((t) => String(t?.nome ?? '').trim().toLowerCase())
    .filter((t) => t !== '')
  return [...new Set(nomes)]
}

export async function tinyV3ObterEstoque(accessToken: string, id: string): Promise<{
  externalName: string
  saldo: number
  reservado: number
}[]> {
  const { data } = await tinyV3Get(accessToken, `/estoque/${id}`)
  // deno-lint-ignore no-explicit-any
  const depositos: any[] = Array.isArray(data?.depositos) ? data.depositos : []
  if (depositos.length === 0) {
    // Produto sem split por depósito: o saldo total vale como depósito único.
    return [{
      externalName: 'Tiny',
      saldo: Number(data?.saldo ?? 0),
      reservado: Number(data?.reservado ?? 0),
    }]
  }
  return depositos.map((d) => ({
    externalName: String(d.nome ?? ''),
    saldo: Number(d.saldo ?? 0),
    // Peças comprometidas em pedidos de venda em aberto. disponivel do Tiny
    // = saldo − reservado; derivamos no banco em vez de gravar os dois.
    reservado: Number(d.reservado ?? 0),
  }))
}

// ---------------------------------------------------------------------------
// Ordens de compra — SÓ existem na v3 (a v2 não tem o recurso). Situação:
// 0 = Em Aberto · 1 = Atendido · 2 = Cancelado · 3 = Em Andamento.
// Em aberto/andamento contam como estoque em trânsito no motor.
// ---------------------------------------------------------------------------

export async function tinyV3ListarOrdensCompra(
  accessToken: string,
  situacao: number,
  pagina: number,
): Promise<{ ids: string[]; numeroPaginas: number }> {
  const { data } = await tinyV3Get(accessToken, '/ordem-compra', {
    situacao: String(situacao),
    limit: String(V3_PAGE_SIZE),
    offset: String((pagina - 1) * V3_PAGE_SIZE),
  })
  // deno-lint-ignore no-explicit-any
  const ids = (data?.itens ?? []).map((o: any) => String(o.id))
  const total = Number(data?.paginacao?.total ?? ids.length)
  return { ids, numeroPaginas: Math.max(1, Math.ceil(total / V3_PAGE_SIZE)) }
}

export async function tinyV3ObterOrdemCompra(accessToken: string, id: string): Promise<{
  id: string
  numero: string | null
  /** ISO `yyyy-MM-dd` — data de criação da ordem. */
  orderedOn: string
  /** 0 aberto · 1 atendido · 2 cancelado · 3 em andamento. */
  situacao: number
  /** ISO `yyyy-MM-dd` ou null — a `dataPrevista` da ordem. */
  etaOn: string | null
  fornecedor: string | null
  itens: { sku: string | null; quantidade: number; preco: number }[]
}> {
  const { data: o } = await tinyV3Get(accessToken, `/ordem-compra/${id}`)
  // deno-lint-ignore no-explicit-any
  const itens = (o?.itens ?? []).map((i: any) => ({
    sku: i.produto?.sku || null,
    quantidade: Number(i.quantidade ?? 0),
    preco: Number(i.preco ?? 0),
  }))
  const eta = String(o?.dataPrevista ?? '').slice(0, 10)
  return {
    id: String(o.id),
    numero: o.numeroPedido != null ? String(o.numeroPedido) : null,
    orderedOn: String(o.data ?? '').slice(0, 10),
    situacao: Number(o.situacao ?? 0),
    etaOn: /^\d{4}-\d{2}-\d{2}$/.test(eta) ? eta : null,
    fornecedor: o.contato?.nome ? String(o.contato.nome) : null,
    itens,
  }
}

export async function tinyV3PesquisarPedidos(
  accessToken: string,
  dataInicialIso: string,
  dataFinalIso: string,
  pagina: number,
): Promise<{ pedidos: { id: string }[]; numeroPaginas: number }> {
  const { data } = await tinyV3Get(accessToken, '/pedidos', {
    dataInicial: dataInicialIso,
    dataFinal: dataFinalIso,
    limit: String(V3_PAGE_SIZE),
    offset: String((pagina - 1) * V3_PAGE_SIZE),
  })
  // deno-lint-ignore no-explicit-any
  const pedidos = (data?.itens ?? []).map((p: any) => ({ id: String(p.id) }))
  const total = Number(data?.paginacao?.total ?? pedidos.length)
  return { pedidos, numeroPaginas: Math.max(1, Math.ceil(total / V3_PAGE_SIZE)) }
}

export async function tinyV3ObterPedido(accessToken: string, id: string): Promise<{
  id: string
  numero: string | null
  /** ISO `yyyy-MM-dd` — a v3 já fala ISO, sem conversão de dd/mm/yyyy. */
  soldOn: string
  situacao: string
  itens: { codigo: string | null; quantidade: number; valorUnitario: number }[]
}> {
  const { data: p } = await tinyV3Get(accessToken, `/pedidos/${id}`)
  // deno-lint-ignore no-explicit-any
  const itens = (p?.itens ?? []).map((i: any) => ({
    codigo: i.produto?.sku || null,
    quantidade: Number(i.quantidade ?? 0),
    valorUnitario: Number(i.valorUnitario ?? 0),
  }))
  return {
    id: String(p.id),
    numero: p.numeroPedido != null ? String(p.numeroPedido) : null,
    soldOn: String(p.data ?? '').slice(0, 10),
    situacao: V3_SITUACAO_PEDIDO[Number(p.situacao)] ?? String(p.situacao ?? ''),
    itens,
  }
}
