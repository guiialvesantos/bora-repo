#!/usr/bin/env node
/**
 * Extrai a planilha legada para `tests/fixtures/`.
 *
 * As fixtures têm dois papéis diferentes e não devem ser confundidos:
 *  - ENTRADA  (sales/products/in_transit/discontinued): o que o importador receberia.
 *  - PADRÃO-OURO (golden_items/golden_totals/sigma_legacy): o que a planilha calculou
 *    a partir dessa entrada. É contra isso que o harness de paridade diffa.
 *
 * Uso: node scripts/xlsx-to-fixtures.mjs [caminho/para/planilha.xlsx]
 */
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import * as XLSX from 'xlsx'

const __dirname = dirname(fileURLToPath(import.meta.url))
const ROOT = resolve(__dirname, '..')
const OUT = resolve(ROOT, 'tests/fixtures')

const XLSX_PATH = resolve(
  process.argv[2] ?? resolve(ROOT, '..', 'Planilha de Cálculo de Pedido Triana.xlsx'),
)

const wb = XLSX.read(readFileSync(XLSX_PATH), { cellDates: true, cellNF: false, cellText: false })

function sheet(name) {
  const ws = wb.Sheets[name]
  if (!ws) throw new Error(`Aba "${name}" não existe. Abas: ${wb.SheetNames.join(', ')}`)
  return ws
}

/** Lê um retângulo de células cruas (valor em cache, sem formatação). */
function readRange(name, ref) {
  const ws = sheet(name)
  const range = XLSX.utils.decode_range(ref)
  const rows = []
  for (let r = range.s.r; r <= range.e.r; r++) {
    const row = []
    for (let c = range.s.c; c <= range.e.c; c++) {
      const cell = ws[XLSX.utils.encode_cell({ r, c })]
      row.push(cell === undefined ? null : (cell.v ?? null))
    }
    rows.push(row)
  }
  return rows
}

function isoDate(v) {
  if (v === null || v === undefined || v === '') return ''
  if (v instanceof Date) {
    // SheetJS devolve a data em UTC; formatar por componentes UTC evita escorregar um dia.
    return `${v.getUTCFullYear()}-${String(v.getUTCMonth() + 1).padStart(2, '0')}-${String(
      v.getUTCDate(),
    ).padStart(2, '0')}`
  }
  if (typeof v === 'number') return isoDate(XLSX.SSF.parse_date_code(v, { date1904: false }) && new Date(Date.UTC(
    XLSX.SSF.parse_date_code(v).y, XLSX.SSF.parse_date_code(v).m - 1, XLSX.SSF.parse_date_code(v).d,
  )))
  return String(v)
}

function csvCell(v) {
  if (v === null || v === undefined) return ''
  const s = typeof v === 'number' ? String(v) : String(v)
  // Sempre entre aspas: as referências em trânsito têm espaço à direita significativo
  // (`'C03CL51O  '`) e um CSV sem aspas perderia isso na leitura.
  return `"${s.replaceAll('"', '""')}"`
}

function writeCsv(file, header, rows) {
  const body = rows.map((r) => r.map(csvCell).join(',')).join('\n')
  writeFileSync(resolve(OUT, file), `${header.join(',')}\n${body}\n`)
  console.log(`  ${file.padEnd(22)} ${rows.length} linhas`)
}

mkdirSync(OUT, { recursive: true })
console.log(`Lendo ${XLSX_PATH}\n`)

// ---------------------------------------------------------------- entrada

const sales = readRange('BD Vendas', 'A2:C10999')
  .filter((r) => r[2] !== null && r[2] !== '')
  .map((r) => [isoDate(r[0]), r[1], r[2]])
writeCsv('sales.csv', ['sold_on', 'qty', 'sku'], sales)

const products = readRange('Estoque olist', 'A2:E249')
  .filter((r) => r[0] !== null && r[0] !== '')
  // `source_row` preserva a ordem original da planilha: é o critério de desempate
  // do SORTBY da curva ABC (SORTBY do Excel é estável).
  .map((r, i) => [i + 1, r[0], r[1], r[2], r[3], r[4]])
writeCsv(
  'products.csv',
  ['source_row', 'sku', 'name', 'stock_total', 'sale_price', 'cmv'],
  products,
)

const inTransit = readRange('BD Estoque Trânsito', 'A2:D192')
  .filter((r) => r[0] !== null && r[0] !== '')
  .map((r) => [r[0], isoDate(r[1]), r[2], r[3]])
writeCsv('in_transit.csv', ['sku_raw', 'eta', 'qty', 'category'], inTransit)

const discontinued = readRange('Itens descontinuados', 'A2:B974')
  .filter((r) => r[0] !== null && r[0] !== '')
  .map((r) => [r[0], r[1]])
writeCsv('discontinued.csv', ['sku', 'name'], discontinued)

// ------------------------------------------------------------ padrão-ouro

const sigma = readRange('BD Desv Padrão', 'A2:B445')
  .filter((r) => r[0] !== null && r[0] !== '')
  .map((r) => [r[0], r[1]])
writeCsv('sigma_legacy.csv', ['sku', 'sigma'], sigma)

// `Processamento` A..Z — o resultado por SKU que precisamos reproduzir.
const GOLDEN_COLS = [
  'sku', // A
  'name', // B
  'stock_office', // C
  'stock_store', // D
  'stock_total', // E
  'sale_price', // F
  'cmv_raw', // G
  'cmv_suspect', // H
  'cmv_used', // I
  'first_sale_date', // J
  'weeks_in_catalog', // K
  'total_sales', // L
  'weekly_all', // M
  'weekly_recent', // N
  'weekly_blended', // O
  'weekly_revenue', // P
  'sigma', // Q
  'abc_class', // R
  'z', // S
  'safety_stock', // T
  'reorder_point', // U
  'max_stock', // V
  'in_transit', // W
  'in_collection', // X
  'should_order', // Y
  'qty_to_order', // Z
]
const golden = readRange('Processamento', 'A2:Z601')
  .filter((r) => r[0] !== null && r[0] !== '')
  .map((r) => r.map((v, i) => (GOLDEN_COLS[i] === 'first_sale_date' ? isoDate(v) : v)))
writeCsv('golden_items.csv', GOLDEN_COLS, golden)

// `Variáveis` — parâmetros e os sete agregados nas duas bases.
const v = (ref) => {
  const cell = sheet('Variáveis')[ref]
  return cell === undefined ? null : (cell.v ?? null)
}

const totals = {
  params: {
    lead_time_days: v('B2'),
    lead_time_weeks: v('B3'),
    min_sale_date: isoDate(v('B4')),
    max_sale_date: isoDate(v('B5')),
    service_level_c: v('B6'),
    z_c: v('B7'),
    service_level_a: v('B8'),
    z_a: v('B9'),
    service_level_b: v('B10'),
    z_b: v('B11'),
    order_cycle_weeks: v('B12'),
    cmv_pct: v('B13'),
  },
  // { a preço de venda, em custo }
  aggregates: {
    current: [v('L3'), v('M3')],
    discontinued: [v('L4'), v('M4')],
    active: [v('L5'), v('M5')],
    safety: [v('L7'), v('M7')],
    average: [v('L8'), v('M8')],
    max_active: [v('L9'), v('M9')],
    max_with_discontinued: [v('L10'), v('M10')],
  },
  counts: {
    skus: golden.length,
    in_collection: golden.filter((r) => r[GOLDEN_COLS.indexOf('in_collection')] === 'Sim').length,
    abc: golden.reduce((acc, r) => {
      const k = r[GOLDEN_COLS.indexOf('abc_class')]
      if (k === 'A' || k === 'B' || k === 'C') acc[k] = (acc[k] ?? 0) + 1
      return acc
    }, {}),
    order_lines: golden.filter((r) => r[GOLDEN_COLS.indexOf('should_order')] === 'Sim').length,
    order_pieces: golden.reduce(
      (s, r) => s + (Number(r[GOLDEN_COLS.indexOf('qty_to_order')]) || 0),
      0,
    ),
  },
}
writeFileSync(resolve(OUT, 'golden_totals.json'), `${JSON.stringify(totals, null, 2)}\n`)
console.log(`  golden_totals.json     ${Object.keys(totals.aggregates).length} agregados`)
console.log('\n', JSON.stringify(totals.counts))
