import * as XLSX from 'xlsx'
import { z } from 'zod'
import type { ImportKind } from '@/lib/replenishment-types'

/**
 * Parse dos quatro artefatos que hoje são colados à mão na planilha.
 *
 * Duas decisões que parecem detalhe e não são:
 *
 * 1. **SKU não é aparado.** `'C03CL51O  '` com dois espaços à direita existe de
 *    verdade na base de em-trânsito, e é exatamente por causa dele que 25 peças
 *    somem do abatimento no modo de paridade. Aparar aqui apagaria a evidência
 *    e a tela de saúde não teria o que apontar. Quem decide se o espaço conta é
 *    o `sku_match_mode`, no motor — não o parser.
 *
 * 2. **Cabeçalho é reconhecido, não exigido.** Os exports do Olist mudam de
 *    rótulo entre versões, e um importador que quebra por causa de um acento a
 *    mais vira um importador que ninguém usa. Se o cabeçalho não casa, caímos
 *    na posição das colunas — que é como a planilha sempre leu.
 */

export interface ParsedFile {
  kind: ImportKind
  rows: Record<string, unknown>[]
  /** Linhas descartadas e o porquê. Vai para a tela antes de gravar. */
  skipped: { row: number; reason: string }[]
}

type Matrix = (string | number | Date | null)[][]

/**
 * Lê xlsx ou csv como matriz crua, sem inferir cabeçalho.
 *
 * `raw: true` desliga a adivinhação de tipo do CSV, e isso não é preferência:
 * sem ele o SKU `01` do catálogo da Triana chega como o número `1`, deixa de
 * casar com a venda e com o em-trânsito, e vira um item fantasma de estoque
 * zero ao lado do original. Num catálogo de bijuteria códigos numéricos curtos
 * são comuns, então o dano é silencioso e recorrente. Em xlsx a opção não muda
 * nada — lá a célula já vem com tipo, e `cellDates` continua devolvendo Date.
 * Converter texto em número é trabalho do `number()`, que sabe o que fazer com
 * `R$ 1.234,56`; o xlsx não sabe.
 */
export async function readMatrix(file: File): Promise<Matrix> {
  const buf = await file.arrayBuffer()
  const wb = XLSX.read(buf, { cellDates: true, raw: true, codepage: 65001 })
  const ws = wb.Sheets[wb.SheetNames[0]]
  if (!ws) throw new Error('Arquivo sem planilha legível.')
  return XLSX.utils.sheet_to_json<Matrix[number]>(ws, {
    header: 1, defval: null, blankrows: false, rawNumbers: true,
  }) as Matrix
}

function norm(v: unknown): string {
  return String(v ?? '')
    .normalize('NFD').replace(/[\u0300-\u036f]/g, '')
    .toLowerCase().trim()
}

/** Mantém o texto como está — inclusive espaço. Ver o comentário do topo. */
function text(v: unknown): string {
  if (v == null) return ''
  if (v instanceof Date) return isoDate(v)
  return String(v)
}

/** Aceita `1.234,56`, `1,234.56` e `R$ 1.234,56`. É o que sai dos exports. */
function number(v: unknown): number | null {
  if (v == null || v === '') return null
  if (typeof v === 'number') return Number.isFinite(v) ? v : null
  let s = String(v).replace(/[^\d.,-]/g, '')
  if (s === '' || s === '-') return null
  const lastComma = s.lastIndexOf(',')
  const lastDot = s.lastIndexOf('.')
  // O último separador que aparece é o decimal; o outro é milhar.
  if (lastComma > lastDot) s = s.replace(/\./g, '').replace(',', '.')
  else s = s.replace(/,/g, '')
  const n = Number(s)
  return Number.isFinite(n) ? n : null
}

function isoDate(v: unknown): string {
  if (v == null || v === '') return ''
  if (v instanceof Date) {
    // Data vinda do xlsx chega em UTC; formatar por componente UTC evita
    // escorregar um dia para trás no fuso de São Paulo.
    const p = (n: number) => String(n).padStart(2, '0')
    return `${v.getUTCFullYear()}-${p(v.getUTCMonth() + 1)}-${p(v.getUTCDate())}`
  }
  const s = String(v).trim()
  const br = /^(\d{1,2})[/-](\d{1,2})[/-](\d{4})$/.exec(s)
  if (br) return `${br[3]}-${br[2].padStart(2, '0')}-${br[1].padStart(2, '0')}`
  const iso = /^(\d{4})-(\d{2})-(\d{2})/.exec(s)
  if (iso) return `${iso[1]}-${iso[2]}-${iso[3]}`
  return ''
}

// ------------------------------------------------------------------ colunas

interface Spec {
  /** Rótulos aceitos, já normalizados. Primeiro que casar vence. */
  aliases: string[]
  /** Posição de fallback quando o cabeçalho não é reconhecido. */
  fallback: number
  required?: boolean
}

const SPECS: Record<ImportKind, Record<string, Spec>> = {
  products: {
    sku:         { aliases: ['sku', 'codigo', 'codigo (sku)', 'referencia'], fallback: 0, required: true },
    name:        { aliases: ['nome', 'descricao', 'produto'], fallback: 1 },
    stock_total: { aliases: ['estoque', 'saldo', 'estoque total', 'quantidade'], fallback: 2 },
    sale_price:  { aliases: ['preco', 'preco de venda', 'valor', 'preco venda'], fallback: 3 },
    cmv:         { aliases: ['cmv', 'custo', 'preco de custo', 'custo unitario'], fallback: 4 },
  },
  sales: {
    sold_on: { aliases: ['data', 'data da venda', 'emissao', 'data emissao'], fallback: 0, required: true },
    qty:     { aliases: ['quantidade', 'qtd', 'qtde'], fallback: 1, required: true },
    sku:     { aliases: ['sku', 'sku_raw', 'codigo', 'referencia'], fallback: 2, required: true },
  },
  in_transit: {
    sku:      { aliases: ['sku', 'sku_raw', 'codigo', 'referencia'], fallback: 0, required: true },
    eta:      { aliases: ['previsao', 'data', 'eta', 'previsao de chegada'], fallback: 1 },
    qty:      { aliases: ['quantidade', 'qtd', 'qtde'], fallback: 2, required: true },
    category: { aliases: ['categoria', 'tipo', 'linha'], fallback: 3 },
  },
  discontinued: {
    sku:  { aliases: ['sku', 'codigo', 'referencia'], fallback: 0, required: true },
    name: { aliases: ['nome', 'descricao', 'produto'], fallback: 1 },
  },
  sigma: {
    sku:   { aliases: ['sku', 'codigo', 'referencia'], fallback: 0, required: true },
    sigma: { aliases: ['sigma', 'desvio', 'desvio padrao', 'desv padrao'], fallback: 1, required: true },
  },
}

interface Layout {
  index: Record<string, number>
  headerRow: number
  /** Verdadeiro quando caímos na posição — a tela avisa. */
  byPosition: boolean
}

function resolveLayout(kind: ImportKind, m: Matrix): Layout {
  const spec = SPECS[kind]
  const head = (m[0] ?? []).map(norm)
  const index: Record<string, number> = {}
  let hits = 0

  for (const [field, s] of Object.entries(spec)) {
    // O próprio nome do campo sempre vale como rótulo: um arquivo exportado
    // deste sistema tem que voltar para dentro dele sem ajuste manual.
    const accepted = [field, ...s.aliases]
    const at = head.findIndex((h) => h !== '' && accepted.includes(h))
    if (at >= 0) { index[field] = at; hits += 1 } else index[field] = s.fallback
  }

  // Metade dos campos reconhecidos já é cabeçalho. Menos que isso e a primeira
  // linha provavelmente é dado, não título.
  const recognized = hits >= Math.ceil(Object.keys(spec).length / 2)
  return { index, headerRow: recognized ? 1 : 0, byPosition: !recognized }
}

// ------------------------------------------------------------------- schemas

const nonEmpty = z.string().min(1)

const SCHEMAS: Record<ImportKind, z.ZodType> = {
  products: z.object({
    sku: nonEmpty,
    name: z.string(),
    // Sem piso em zero: estoque negativo existe de verdade (venda faturada
    // antes da baixa) e são 4 SKUs na base atual — um deles a maior linha do
    // pedido de compra. Recusar a linha tiraria o item do catálogo inteiro
    // para "proteger" um número que o motor já trata: quanto mais negativo,
    // mais ele manda comprar, que é o comportamento certo.
    stock_total: z.number(),
    sale_price: z.number().min(0),
    cmv: z.number().min(0).nullable(),
  }),
  sales: z.object({
    sold_on: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'data inválida'),
    qty: z.number(),
    sku: nonEmpty,
  }),
  in_transit: z.object({
    sku: nonEmpty,
    eta: z.string(),
    qty: z.number().min(0),
    category: z.string(),
  }),
  discontinued: z.object({ sku: nonEmpty, name: z.string() }),
  sigma: z.object({ sku: nonEmpty, sigma: z.number().min(0) }),
}

function build(kind: ImportKind, row: Matrix[number], ix: Record<string, number>) {
  const at = (f: string) => row[ix[f]] ?? null
  switch (kind) {
    case 'products':
      return {
        sku: text(at('sku')).trim(),
        name: text(at('name')).trim(),
        stock_total: number(at('stock_total')) ?? 0,
        sale_price: number(at('sale_price')) ?? 0,
        cmv: number(at('cmv')),
      }
    case 'sales':
      return {
        sold_on: isoDate(at('sold_on')),
        qty: number(at('qty')) ?? 0,
        sku: text(at('sku')).trim(),
      }
    case 'in_transit':
      // Sem `.trim()`: o espaço sobrando é o dado. Ver o comentário do topo.
      return {
        sku: text(at('sku')),
        eta: isoDate(at('eta')),
        qty: number(at('qty')) ?? 0,
        category: text(at('category')).trim(),
      }
    case 'discontinued':
      return { sku: text(at('sku')), name: text(at('name')).trim() }
    case 'sigma':
      return { sku: text(at('sku')).trim(), sigma: number(at('sigma')) ?? 0 }
  }
}

export function parseMatrix(kind: ImportKind, m: Matrix): ParsedFile & { byPosition: boolean } {
  const { index, headerRow, byPosition } = resolveLayout(kind, m)
  const schema = SCHEMAS[kind]
  const rows: Record<string, unknown>[] = []
  const skipped: { row: number; reason: string }[] = []

  for (let r = headerRow; r < m.length; r++) {
    const raw = m[r]
    if (!raw || raw.every((c) => c == null || String(c).trim() === '')) continue

    const candidate = build(kind, raw, index)
    const parsed = schema.safeParse(candidate)
    if (parsed.success) {
      const out = parsed.data as Record<string, unknown>
      // `source_row` é a ordem original do arquivo, e é o desempate da curva
      // ABC: o SORTBY do Excel é estável, então dois itens de mesmo
      // faturamento mantêm a ordem em que foram digitados. Sem isto o
      // desempate cairia no SKU e um deles poderia trocar de classe — e de
      // nível de serviço — só por ter sido reimportado.
      if (kind === 'products') out.source_row = rows.length + 1
      rows.push(out)
    } else {
      skipped.push({
        row: r + 1,
        reason: parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; '),
      })
    }
  }

  return { kind, rows, skipped, byPosition }
}
