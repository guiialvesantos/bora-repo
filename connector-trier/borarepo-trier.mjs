#!/usr/bin/env node
// ============================================================================
// Conector BoraRepô ↔ Trier Sistemas
// ----------------------------------------------------------------------------
// Roda DENTRO da farmácia, no mesmo computador (ou na mesma rede) do servidor
// SGF. Lê a API local da Trier e empurra o resultado para o BoraRepô por HTTPS.
//
//   node borarepo-trier.mjs --test     valida a configuração e sai
//   node borarepo-trier.mjs --once     roda um ciclo e sai
//   node borarepo-trier.mjs            roda para sempre
//
// Zero dependência: só Node 20 ou superior. Não há `npm install`, não há
// `node_modules`, não há build. Um arquivo e um JSON de configuração, porque
// quem instala isso é o técnico de TI da farmácia num Windows Server que
// ninguém quer mexer — e cada passo a mais é uma chance a mais de não instalar.
//
// ----------------------------------------------------------------------------
// Por que o conector existe
//
// A API SGF é on-premise: `http://localhost:4647/sgfpod1`, sem TLS, endereço
// que só existe dentro da loja. A alternativa seria a farmácia abrir a porta
// 4647 no roteador, como a Trier documenta — o que põe o ERP inteiro na
// internet em texto claro e nem funciona em link com CGNAT. Este processo
// inverte a direção: lê em loopback, escreve para fora. Nenhuma porta aberta.
//
// Consequência: **o token da Trier nunca sai daqui**. Ele fica neste arquivo de
// configuração, ao lado do servidor que ele acessa.
//
// ----------------------------------------------------------------------------
// O que ele NÃO faz, de propósito
//
// Não traduz nada. Os objetos da Trier sobem crus e a tradução acontece no
// servidor. Quando um campo estiver mapeado errado — e vai estar, o spec é
// 1.5.14 e já traz divergências declaradas — o conserto é um deploy nosso, não
// uma atualização de programa em duzentos computadores de farmácia.
// ============================================================================

import { readFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const VERSION = '1.0.0'
const HERE = dirname(fileURLToPath(import.meta.url))

// ---------------------------------------------------------------------------
// Configuração
// ---------------------------------------------------------------------------

const argv = process.argv.slice(2)
const flag = (name) => argv.includes(`--${name}`)
const argValue = (name) => {
  const i = argv.indexOf(`--${name}`)
  return i >= 0 ? argv[i + 1] : null
}

const CONFIG_PATH = resolve(argValue('config') ?? `${HERE}/borarepo.config.json`)

let config
try {
  config = JSON.parse(readFileSync(CONFIG_PATH, 'utf8'))
} catch (err) {
  console.error(`Não consegui ler a configuração em ${CONFIG_PATH}`)
  console.error(err.message)
  process.exit(1)
}

const REQUIRED = ['trierBaseUrl', 'trierToken', 'ingestUrl', 'connectorKey']
const missing = REQUIRED.filter((k) => !config[k])
if (missing.length > 0) {
  console.error(`Faltam campos na configuração: ${missing.join(', ')}`)
  process.exit(1)
}

const TRIER_BASE = String(config.trierBaseUrl).replace(/\/+$/, '')
const PAGE_SIZE = Number(config.pageSize ?? 500)
const INTERVAL_MS = Number(config.intervalMinutes ?? 15) * 60_000
// Quanto do passado o primeiro ciclo busca. 12 meses é o que o motor usa para
// estimar sazonalidade; menos que isso e a primeira sugestão de compra sai com
// desvio-padrão medido em ruído.
const BACKFILL_MONTHS = Number(config.backfillMonths ?? 12)
// Reler alguns minutos já lidos a cada ciclo. Lançamento com data retroativa e
// relógio do servidor fora de hora são rotina no varejo; sem essa sobreposição
// a venda cai exatamente na fresta entre dois ciclos e some para sempre.
const OVERLAP_MINUTES = Number(config.overlapMinutes ?? 30)

// ---------------------------------------------------------------------------
// Utilidades
// ---------------------------------------------------------------------------

const log = (...parts) => console.log(new Date().toISOString(), '·', ...parts)
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

const isoNow = () => new Date().toISOString().replace(/\.\d{3}Z$/, '')
const isoMinus = (from, ms) => new Date(new Date(from).getTime() - ms).toISOString().replace(/\.\d{3}Z$/, '')

/**
 * Uma tentativa de rede não é um veredito. A internet da farmácia cai, o
 * servidor SGF reinicia à noite, o antivírus segura a primeira conexão do dia —
 * tudo isso é transitório e volta sozinho. Erro de autorização (401/403) é o
 * oposto: repetir não conserta e só enche o log, então sobe na hora.
 */
async function withRetry(what, fn, attempts = 4) {
  let wait = 2000
  for (let i = 1; ; i += 1) {
    try {
      return await fn()
    } catch (err) {
      if (err.status === 401 || err.status === 403 || i >= attempts) throw err
      log(`${what}: tentativa ${i} falhou (${err.message}); repetindo em ${wait / 1000}s`)
      await sleep(wait)
      wait *= 2
    }
  }
}

async function httpJson(url, options = {}) {
  const res = await fetch(url, options)
  const text = await res.text()
  if (!res.ok) {
    const err = new Error(`HTTP ${res.status} — ${text.slice(0, 200)}`)
    err.status = res.status
    throw err
  }
  if (!text) return null
  try {
    return JSON.parse(text)
  } catch {
    throw new Error(`Resposta não é JSON: ${text.slice(0, 200)}`)
  }
}

// ---------------------------------------------------------------------------
// API da Trier
// ---------------------------------------------------------------------------

/**
 * As respostas da SGF são ARRAYS NUS: não vem envelope, não vem total, não vem
 * "há mais páginas". O fim da lista é `length < quantidadeRegistros` e não há
 * outro sinal — por isso a paginação é por offset e para quando a página vem
 * incompleta.
 */
async function* trierPages(path, params = {}) {
  let primeiroRegistro = 0
  for (;;) {
    const qs = new URLSearchParams({
      ...params,
      primeiroRegistro: String(primeiroRegistro),
      quantidadeRegistros: String(PAGE_SIZE),
    })
    const url = `${TRIER_BASE}${path}?${qs}`
    const rows = await withRetry(path, () =>
      httpJson(url, { headers: { Authorization: `Bearer ${config.trierToken}`, Accept: 'application/json' } }))
    const list = Array.isArray(rows) ? rows : []
    if (list.length > 0) yield list
    if (list.length < PAGE_SIZE) return
    primeiroRegistro += PAGE_SIZE
  }
}

// ---------------------------------------------------------------------------
// BoraRepô
// ---------------------------------------------------------------------------

async function push(kind, rows, { cursor, done } = {}) {
  return withRetry(`enviar ${kind}`, () =>
    httpJson(config.ingestUrl, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${config.connectorKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ version: VERSION, kind, rows, cursor, done }),
    }))
}

// ---------------------------------------------------------------------------
// Os seis fluxos
// ---------------------------------------------------------------------------

/**
 * Cada fluxo tem duas formas: a PRIMEIRA vez varre tudo (`obter-todos`), as
 * seguintes pedem só o que mudou desde o último cursor. O cursor mora no
 * servidor — trocar o computador da loja não pode disparar um backfill de 12
 * meses de novo.
 *
 * A ordem importa. Produto vem antes de estoque e de venda porque é ele que
 * cria a linha que as outras duas referenciam; pedido vem antes de compra
 * porque a compra BAIXA o pedido.
 */
function planCycle(cursors) {
  const agora = isoNow()
  const desde = (kind, fallbackMs) => {
    const c = cursors?.[kind]
    return c ? isoMinus(c, OVERLAP_MINUTES * 60_000) : isoMinus(agora, fallbackMs)
  }
  const ANO = BACKFILL_MONTHS * 30 * 24 * 3600_000

  return [
    cursors?.produtos
      ? { kind: 'produtos', path: '/integracao/produto/obter-alterados-v1', params: { dataInicial: desde('produtos', ANO), dataFinal: agora }, cursor: agora }
      : { kind: 'produtos', path: '/integracao/produto/obter-todos-v1', params: {}, cursor: agora },

    cursors?.estoque
      ? { kind: 'estoque', path: '/integracao/estoque/obter-movimentados-v1', params: { dataInicial: desde('estoque', ANO), dataFinal: agora }, cursor: agora }
      : { kind: 'estoque', path: '/integracao/estoque/obter-todos-v1', params: {}, cursor: agora },

    {
      kind: 'vendas',
      path: '/integracao/venda/obter-v1',
      params: { dataEmissaoInicial: desde('vendas', ANO), dataEmissaoFinal: agora },
      cursor: agora,
    },
    {
      kind: 'cancelamentos',
      path: '/integracao/venda/cancelamento/obter-v1',
      params: { dataEmissaoInicial: desde('cancelamentos', ANO), dataEmissaoFinal: agora },
      cursor: agora,
    },
    {
      // Pedido em aberto = o "em trânsito" do motor. A janela é curta de
      // propósito: pedido de farmácia entrega em dias, e reler o ano inteiro a
      // cada ciclo só gastaria banda para reescrever pedido já recebido.
      kind: 'pedidos',
      path: '/integracao/pedido/itens/resumido/obter-v1',
      params: { dataEmissaoInicial: desde('pedidos', 90 * 24 * 3600_000), dataEmissaoFinal: agora },
      cursor: agora,
    },
    {
      kind: 'compras',
      path: '/integracao/compra/obter-v1',
      params: { dataEntradaInicial: desde('compras', 90 * 24 * 3600_000), dataEntradaFinal: agora },
      cursor: agora,
    },
  ]
}

async function runCycle() {
  const hello = await push('hello', [])
  log(`conectado como "${hello.label}"`)

  const maxRows = hello.limits?.maxRows ?? 1000
  let cursors = hello.cursors ?? {}

  for (const step of planCycle(cursors)) {
    let enviados = 0
    let buffer = []

    const flush = async (done) => {
      if (buffer.length === 0 && !done) return
      const res = await push(step.kind, buffer, { cursor: done ? step.cursor : undefined, done })
      cursors = res.cursors ?? cursors
      enviados += buffer.length
      buffer = []
    }

    for await (const page of trierPages(step.path, step.params)) {
      for (const row of page) {
        buffer.push(row)
        // O lote do envio é menor que a página da Trier de propósito: quem
        // manda no tamanho é o teto da Edge Function, não o do ERP.
        if (buffer.length >= maxRows) await flush(false)
      }
    }
    // O `done` final anda o cursor E carimba o frescor na tela de Saúde —
    // acontece mesmo sem linha nenhuma, porque "nada mudou hoje" também é
    // informação e o contrário parece integração quebrada.
    await flush(true)
    log(`${step.kind}: ${enviados} registro(s)`)
  }
}

// ---------------------------------------------------------------------------
// Modo teste — o que o técnico roda ANTES de instalar como serviço
// ---------------------------------------------------------------------------

async function runTest() {
  log(`conector v${VERSION} · configuração: ${CONFIG_PATH}`)

  log(`testando a API da Trier em ${TRIER_BASE} ...`)
  const qs = new URLSearchParams({ primeiroRegistro: '0', quantidadeRegistros: '1' })
  const amostra = await httpJson(`${TRIER_BASE}/integracao/produto/obter-todos-v1?${qs}`, {
    headers: { Authorization: `Bearer ${config.trierToken}`, Accept: 'application/json' },
  })
  if (!Array.isArray(amostra)) throw new Error('A Trier não devolveu uma lista de produtos')
  log(`Trier respondeu (${amostra.length} produto de amostra)`)
  if (amostra[0]) {
    // Imprimir o primeiro produto é o ponto do teste. É aqui que se descobre,
    // com dado real, quais campos do spec a instalação daquela farmácia
    // realmente preenche — e o spec já mostrou que nem sempre bate.
    log('campos presentes:', Object.keys(amostra[0]).join(', '))
  }

  log(`testando o BoraRepô em ${config.ingestUrl} ...`)
  const hello = await push('hello', [])
  log(`BoraRepô respondeu: loja "${hello.label}"`)
  log('cursores guardados:', JSON.stringify(hello.cursors ?? {}))
  log('tudo certo. Pode instalar como serviço.')
}

// ---------------------------------------------------------------------------

async function main() {
  if (flag('test')) return runTest()

  log(`conector v${VERSION} iniciado · ciclo a cada ${INTERVAL_MS / 60_000} min`)
  for (;;) {
    const inicio = Date.now()
    try {
      await runCycle()
      log(`ciclo concluído em ${Math.round((Date.now() - inicio) / 1000)}s`)
    } catch (err) {
      // O ciclo falha, o processo NÃO. Um erro no meio da madrugada não pode
      // deixar a farmácia sem sincronizar até alguém perceber e reiniciar o
      // serviço na segunda-feira.
      log(`ciclo falhou: ${err.message}`)
    }
    if (flag('once')) return
    await sleep(INTERVAL_MS)
  }
}

main().catch((err) => {
  console.error(err.message)
  process.exit(1)
})
