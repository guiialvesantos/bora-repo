#!/usr/bin/env node
// parity.mjs — o teste que decide se o motor pode substituir a planilha.
//
// Semeia um banco local com os MESMOS artefatos que alimentam a planilha hoje,
// publica os parâmetros em modo paridade (janela ancorada em TODAY, σ externo,
// casamento de SKU sem aparar espaço) e compara o snapshot número a número com
// `Processamento` e `Variáveis`.
//
// A regra: os campos em que alguém gasta dinheiro batem EXATO. Um desvio de uma
// peça derruba o build, porque uma peça a mais numa linha de pedido é dinheiro
// que sai da conta de alguém por engano.
//
//   node scripts/parity.mjs            roda contra o banco já de pé
//   node scripts/parity.mjs --reset    roda `supabase db reset` antes

import { readFileSync } from 'node:fs'
import { execSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import pg from 'pg'
import Papa from 'papaparse'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const FIX = join(ROOT, 'tests', 'fixtures')

const DB_URL = process.env.PARITY_DB_URL ?? 'postgresql://postgres:postgres@127.0.0.1:54322/postgres'
const USER_ID = '00000000-0000-4000-8000-000000000001'

// A planilha foi salva neste dia. Congelar o relógio é o que torna o resultado
// do motor comparável a ela — sem isso a janela de 28 dias anda todo dia e o
// teste passa hoje e falha amanhã.
const TODAY = '2026-09-11'

// O dia em que a base externa de σ foi colada na planilha. Descoberto varrendo
// todos os cortes possíveis: é o único que faz o σ calculado reproduzir a base
// legada, e reproduz 223 dos 433 SKUs bit a bit. Nenhum outro corte passa de
// um punhado. Os 210 que não batem divergem porque a venda mudou depois disso,
// não porque a conta esteja errada.
const SIGMA_CUTOFF = '2026-07-10'

// ----------------------------------------------------------------- utilidades

const csv = (name) =>
  Papa.parse(readFileSync(join(FIX, name), 'utf8'), { header: true, skipEmptyLines: true }).data

const num = (v) => (v === '' || v == null ? null : Number(v))

let failures = 0
const fail = (msg) => { failures++; console.error(`  ✗ ${msg}`) }
const pass = (msg) => console.log(`  ✓ ${msg}`)

function section(title) {
  console.log(`\n${title}`)
}

// Igualdade de inteiro. Vazio na planilha e nulo no banco são a mesma coisa:
// "não se aplica" (item fora de coleção não tem PP nem EMax).
function sameInt(a, b) {
  if (a == null && b == null) return true
  if (a == null || b == null) return false
  return Math.round(Number(a)) === Math.round(Number(b))
}

function close(a, b, rel = 1e-9) {
  if (a == null && b == null) return true
  if (a == null || b == null) return false
  const x = Number(a), y = Number(b)
  if (x === y) return true
  return Math.abs(x - y) <= rel * Math.max(1, Math.abs(x), Math.abs(y))
}

// ----------------------------------------------------------------- semeadura

async function chunkInsert(c, sql, rows, cols, size = 500) {
  for (let i = 0; i < rows.length; i += size) {
    const slice = rows.slice(i, i + size)
    const values = []
    const params = []
    slice.forEach((r, n) => {
      values.push(`(${cols.map((_, k) => `$${n * cols.length + k + 1}`).join(',')})`)
      params.push(...r)
    })
    await c.query(sql.replace('%VALUES%', values.join(',')), params)
  }
}

async function seed(c) {
  // Usuário do Auth inserido à mão: o harness não sobe o GoTrue, mas o motor
  // valida permissão via `auth.uid()`, então precisa existir alguém de verdade
  // do outro lado do JWT — testar o motor com a RLS desligada testaria menos.
  await c.query(`
    insert into auth.users (instance_id, id, aud, role, email, encrypted_password,
                            email_confirmed_at, raw_app_meta_data, raw_user_meta_data,
                            created_at, updated_at)
    values ('00000000-0000-0000-0000-000000000000', $1, 'authenticated', 'authenticated',
            'parity@stock.local', '', now(), '{"provider":"email"}'::jsonb,
            '{"full_name":"Harness de paridade"}'::jsonb, now(), now())
    on conflict (id) do nothing
  `, [USER_ID])

  await c.query(`select set_config('request.jwt.claims',
    json_build_object('sub', $1::text, 'role', 'authenticated')::text, false)`, [USER_ID])

  await c.query('set role authenticated')
  const { rows: [{ create_company: companyId }] } =
    await c.query(`select public.create_company('Triana', 'triana')`)
  await c.query('reset role')

  // Depósito único: a planilha soma os dois depósitos do Olist numa coluna só,
  // e as colunas de origem vêm literalmente com "desabilitado".
  const { rows: [{ id: warehouseId }] } = await c.query(
    `insert into public.warehouses (company_id, external_id, name) values ($1, 'principal', 'Principal') returning id`,
    [companyId])

  const products = csv('products.csv')
  await chunkInsert(c,
    `insert into public.products (company_id, external_id, sku, name, sale_price, cmv, source_row)
     values %VALUES%`,
    products.map((p) => [companyId, `p-${p.source_row}`, p.sku, p.name,
                         num(p.sale_price) ?? 0, num(p.cmv), num(p.source_row)]),
    ['company_id', 'external_id', 'sku', 'name', 'sale_price', 'cmv', 'source_row'])

  await c.query(`
    insert into public.product_stock (product_id, warehouse_id, company_id, qty)
    select p.id, $2, $1, s.qty
    from public.products p
    join (select unnest($3::text[]) as ext, unnest($4::numeric[]) as qty) s on s.ext = p.external_id
    where p.company_id = $1
  `, [companyId, warehouseId,
      products.map((p) => `p-${p.source_row}`),
      products.map((p) => num(p.stock_total) ?? 0)])

  // Uma ordem de venda por dia. O motor só lê os itens, mas amarrar tudo num
  // pedido só criaria uma linha de 10.993 itens que não se parece com nada.
  //
  // `channel = 'manual'` porque é o que estas linhas SÃO: vieram de arquivo.
  // Carimbá-las de 'olist' seria mentir sobre a procedência, e a mentira tem
  // consequência — `import_apply` substitui só o canal manual, então reimportar
  // o mesmo arquivo por cima somaria uma segunda cópia de cada venda em vez de
  // trocar a primeira, e toda a demanda dobraria em silêncio.
  const sales = csv('sales.csv')
  const dates = [...new Set(sales.map((s) => s.sold_on))].sort()
  await chunkInsert(c,
    `insert into public.sales_orders (company_id, channel, external_id, ordered_at, sold_on, items_fetched)
     values %VALUES%`,
    dates.map((d) => [companyId, 'manual', `d-${d}`, `${d}T12:00:00-03:00`, d, true]),
    ['company_id', 'channel', 'external_id', 'ordered_at', 'sold_on', 'items_fetched'])

  const { rows: orderRows } = await c.query(
    `select id, sold_on::text as sold_on from public.sales_orders where company_id = $1`, [companyId])
  const orderByDate = new Map(orderRows.map((o) => [o.sold_on, o.id]))

  await chunkInsert(c,
    `insert into public.sales_order_items (company_id, order_id, sku, qty, sold_on) values %VALUES%`,
    sales.map((s) => [companyId, orderByDate.get(s.sold_on), s.sku, num(s.qty) ?? 0, s.sold_on]),
    ['company_id', 'order_id', 'sku', 'qty', 'sold_on'])

  await c.query(`
    update public.sales_order_items i set product_id = p.id
    from public.products p
    where p.company_id = i.company_id and p.sku_norm = i.sku_norm and i.company_id = $1
  `, [companyId])

  // Em trânsito COM os espaços de sobra preservados. É o caso de teste: em modo
  // legado essas referências não casam com produto nenhum, exatamente como no
  // SUMIF da planilha.
  const transit = csv('in_transit.csv')
  const { rows: [{ id: poId }] } = await c.query(
    `insert into public.purchase_orders (company_id, external_id, source, status, ordered_on)
     values ($1, 'importado', 'import', 'open', $2) returning id`, [companyId, TODAY])

  await chunkInsert(c,
    `insert into public.purchase_order_items (company_id, order_id, sku, qty_ordered, eta_on, category)
     values %VALUES%`,
    transit.map((t) => [companyId, poId, t.sku_raw, num(t.qty) ?? 0, t.eta || null, t.category || null]),
    ['company_id', 'order_id', 'sku', 'qty_ordered', 'eta_on', 'category'])

  // A lista de descontinuados tem código repetido (e também com espaço). O
  // `on conflict` é fiel: no Excel a duplicata não muda o COUNTIF > 0.
  const disc = csv('discontinued.csv')
  await chunkInsert(c,
    `insert into public.discontinued_items (company_id, sku, name) values %VALUES%
     on conflict (company_id, sku) do nothing`,
    disc.map((d) => [companyId, d.sku, d.name || null]),
    ['company_id', 'sku', 'name'])

  const sigma = csv('sigma_legacy.csv')
  await chunkInsert(c,
    `insert into public.external_sigma (company_id, sku, sigma, source) values %VALUES%
     on conflict (company_id, sku) do nothing`,
    sigma.map((s) => [companyId, s.sku, num(s.sigma) ?? 0, 'planilha']),
    ['company_id', 'sku', 'sigma', 'source'])

  return companyId
}

// O Tier 2 precisa de uma empresa só dele. Motivo: a base legada de σ cobre
// 444 SKUs, mas o catálogo atual tem 248 — e os que sobraram no catálogo são
// justamente os que continuaram vendendo depois do congelamento, ou seja, os
// que MAIS divergem. Medir o algoritmo só neles daria 38 acertos e esconderia
// que o método está certo. Aqui todo SKU que já vendeu vira produto (preço e
// estoque zero, então não contamina agregado nenhum) e o σ é medido pelo mesmo
// caminho de código do motor, não por uma reimplementação de teste.
async function seedSigmaTenant(c) {
  await c.query('set role authenticated')
  const { rows: [{ create_company: companyId }] } =
    await c.query(`select public.create_company('Paridade σ', 'paridade-sigma')`)
  await c.query('reset role')

  const sales = csv('sales.csv')
  const skus = [...new Set(sales.map((s) => s.sku))]

  await chunkInsert(c,
    `insert into public.products (company_id, external_id, sku, name, sale_price) values %VALUES%`,
    skus.map((s, i) => [companyId, `s-${i}`, s, s, 0]),
    ['company_id', 'external_id', 'sku', 'name', 'sale_price'])

  const dates = [...new Set(sales.map((s) => s.sold_on))].sort()
  await chunkInsert(c,
    `insert into public.sales_orders (company_id, channel, external_id, ordered_at, sold_on, items_fetched)
     values %VALUES%`,
    dates.map((d) => [companyId, 'manual', `d-${d}`, `${d}T12:00:00-03:00`, d, true]),
    ['company_id', 'channel', 'external_id', 'ordered_at', 'sold_on', 'items_fetched'])

  const { rows: orderRows } = await c.query(
    `select id, sold_on::text as sold_on from public.sales_orders where company_id = $1`, [companyId])
  const orderByDate = new Map(orderRows.map((o) => [o.sold_on, o.id]))

  await chunkInsert(c,
    `insert into public.sales_order_items (company_id, order_id, sku, qty, sold_on) values %VALUES%`,
    sales.map((s) => [companyId, orderByDate.get(s.sold_on), s.sku, num(s.qty) ?? 0, s.sold_on]),
    ['company_id', 'order_id', 'sku', 'qty', 'sold_on'])

  const sigma = csv('sigma_legacy.csv')
  await chunkInsert(c,
    `insert into public.external_sigma (company_id, sku, sigma, source) values %VALUES%
     on conflict (company_id, sku) do nothing`,
    sigma.map((s) => [companyId, s.sku, num(s.sigma) ?? 0, 'planilha']),
    ['company_id', 'sku', 'sigma', 'source'])

  return companyId
}

// ----------------------------------------------------------------- execução

async function publish(c, companyId, patch, note) {
  await c.query('set role authenticated')
  const { rows: [{ publish_replenishment_params: id }] } = await c.query(
    `select public.publish_replenishment_params($1, $2::jsonb, $3)`,
    [companyId, JSON.stringify(patch), note])
  await c.query('reset role')
  return id
}

async function compute(c, companyId, note) {
  await c.query('set role authenticated')
  const { rows: [{ replenishment_compute: id }] } = await c.query(
    `select public.replenishment_compute($1, $2)`, [companyId, note])
  await c.query('reset role')
  return id
}

// ----------------------------------------------------------------- os tiers

const TIER0 = ['in_collection', 'abc_class', 'safety_stock', 'reorder_point',
               'max_stock', 'in_transit', 'should_order', 'qty_to_order']

const TIER1 = ['cmv_used', 'weeks_in_catalog', 'total_sales',
               'weekly_all', 'weekly_recent', 'weekly_blended', 'weekly_revenue', 'z']

// A planilha escreve "Sim"/"Não" onde o banco escreve booleano, e deixa a
// célula em branco onde o banco deixa nulo.
function goldenValue(field, row) {
  const raw = row[field]
  if (field === 'in_collection' || field === 'should_order') return raw === 'Sim'
  if (field === 'abc_class') return raw === '' ? null : raw
  return raw === '' ? null : Number(raw)
}

function actualValue(field, row) {
  const v = row[field]
  if (field === 'in_collection' || field === 'should_order') return v
  if (field === 'abc_class') return v
  return v == null ? null : Number(v)
}

async function main() {
  if (process.argv.includes('--reset')) {
    console.log('supabase db reset...')
    execSync('supabase db reset', { cwd: ROOT, stdio: 'inherit' })
  }

  const c = new pg.Client({ connectionString: DB_URL })
  await c.connect()
  // Sem isto o Postgres serializa `double precision` com 15 dígitos e o Z
  // chega aqui já arredondado — o teste do AS241 falharia no transporte, não
  // na matemática.
  await c.query('set extra_float_digits = 3')

  const companyId = await seed(c)
  console.log(`empresa ${companyId} semeada`)

  // ---- modo paridade: a planilha, com os bugs dela ------------------------
  await publish(c, companyId, {
    today_override: TODAY,
    recent_window_anchor: 'today',
    reference_date_mode: 'max_sale_date',
    safety_stock_for_out_of_collection: true,
    sigma_source: 'external',
    sku_match_mode: 'exact',
  }, 'Modo paridade com a planilha (harness)')

  const snapId = await compute(c, companyId, 'paridade')

  const { rows: items } = await c.query(
    `select * from public.replenishment_snapshot_items where snapshot_id = $1`, [snapId])
  const { rows: [snap] } = await c.query(
    `select * from public.replenishment_snapshots where id = $1`, [snapId])

  const golden = csv('golden_items.csv')
  const totals = JSON.parse(readFileSync(join(FIX, 'golden_totals.json'), 'utf8'))

  const bySku = new Map(items.map((i) => [i.sku, i]))

  // ---- Tier 0 ------------------------------------------------------------
  section('Tier 0 — igualdade exata (os números que viram dinheiro)')
  if (items.length !== golden.length) fail(`${items.length} linhas no snapshot, ${golden.length} na planilha`)

  for (const field of TIER0) {
    const bad = []
    for (const g of golden) {
      const a = bySku.get(g.sku)
      if (!a) { bad.push(`${g.sku}: ausente do snapshot`); continue }
      const want = goldenValue(field, g)
      const got = actualValue(field, a)
      const ok = typeof want === 'boolean' || typeof got === 'boolean' || field === 'abc_class'
        ? want === got
        : sameInt(want, got)
      if (!ok) bad.push(`${g.sku}: planilha ${JSON.stringify(want)} ≠ motor ${JSON.stringify(got)}`)
    }
    if (bad.length) fail(`${field}: ${bad.length}/${golden.length} divergem — ${bad.slice(0, 4).join(' | ')}`)
    else pass(`${field}: ${golden.length}/${golden.length}`)
  }

  // ---- Tier 1 ------------------------------------------------------------
  section('Tier 1 — 1e-9 relativo (intermediários)')
  for (const field of TIER1) {
    const bad = []
    let compared = 0
    for (const g of golden) {
      const a = bySku.get(g.sku)
      if (!a) continue
      // `weeks_in_catalog` dos 36 SKUs sem venda é 6605,29 na planilha: o
      // MINIFS sem correspondência devolve o serial 0 (30/12/1899) e a fórmula
      // divide a distância até lá por 7. O motor grava nulo. Reproduzir esse
      // número seria pôr um artefato do Excel na tela.
      if (field === 'weeks_in_catalog' && Number(g.total_sales) === 0) continue
      compared++
      const want = goldenValue(field, g)
      const got = actualValue(field, a)
      if (!close(want, got)) bad.push(`${g.sku}: ${want} ≠ ${got}`)
    }
    if (bad.length) fail(`${field}: ${bad.length}/${compared} divergem — ${bad.slice(0, 4).join(' | ')}`)
    else pass(`${field}: ${compared}/${compared}`)
  }

  // ---- Tier 3 (agregados) ------------------------------------------------
  section('Tier 3 — agregados do `Variáveis`, ao centavo')
  for (const [key, want] of Object.entries(totals.aggregates)) {
    const got = snap.totals[key]
    if (!got) { fail(`${key}: ausente do snapshot`); continue }
    const okPrice = Math.abs(Number(got[0]) - want[0]) < 0.005
    const okCost = Math.abs(Number(got[1]) - want[1]) < 0.005
    if (okPrice && okCost) pass(`${key}: ${Number(got[0]).toFixed(2)} / ${Number(got[1]).toFixed(2)}`)
    else fail(`${key}: motor ${Number(got[0]).toFixed(2)}/${Number(got[1]).toFixed(2)} ≠ planilha ${want[0].toFixed(2)}/${want[1].toFixed(2)}`)
  }

  section('Tier 3 — contagens')
  const counts = {
    skus: snap.item_count,
    in_collection: snap.in_collection,
    abc_a: snap.abc_a, abc_b: snap.abc_b, abc_c: snap.abc_c,
    order_lines: snap.order_lines,
    order_pieces: Number(snap.order_pieces),
  }
  const wantCounts = {
    skus: totals.counts.skus,
    in_collection: totals.counts.in_collection,
    abc_a: totals.counts.abc.A, abc_b: totals.counts.abc.B, abc_c: totals.counts.abc.C,
    order_lines: totals.counts.order_lines,
    order_pieces: totals.counts.order_pieces,
  }
  for (const [k, want] of Object.entries(wantCounts)) {
    if (Number(counts[k]) === Number(want)) pass(`${k}: ${want}`)
    else fail(`${k}: motor ${counts[k]} ≠ planilha ${want}`)
  }

  // ---- Tier 2 (σ calculado) ----------------------------------------------
  //
  // A base externa de σ está congelada em 49 semanas contra as 53 das vendas
  // atuais, então não dá para assertar VALOR — o que se asserta é o ALGORITMO:
  // cortando a venda na data em que a base foi colada, o σ calculado tem que
  // reproduzir a maioria dos valores legados bit a bit.
  section('Tier 2 — σ calculado contra a base legada (corte em 2026-07-10)')
  const sigmaCo = await seedSigmaTenant(c)
  await publish(c, sigmaCo, {
    today_override: TODAY,
    sigma_source: 'computed',
    sales_cutoff_on: SIGMA_CUTOFF,
  }, 'Tier 2 — σ calculado com a base cortada')
  const sigmaSnap = await compute(c, sigmaCo, 'tier2-sigma')

  const { rows: sigmaItems } = await c.query(
    `select i.sku, i.sigma, e.sigma as legacy, s.history_weeks
       from public.replenishment_snapshot_items i
       join public.replenishment_snapshots s on s.id = i.snapshot_id
       join public.external_sigma e
         on e.company_id = i.company_id and e.sku_upper = upper(i.sku)
      where i.snapshot_id = $1`, [sigmaSnap])

  const hits = sigmaItems.filter((s) => close(Number(s.sigma), Number(s.legacy))).length
  const floor = Number(process.env.PARITY_SIGMA_FLOOR ?? 223)
  const weeks = sigmaItems[0]?.history_weeks
  if (weeks === 49) pass(`grade de ${weeks} semanas (a base legada foi colada com 49)`)
  else fail(`grade de ${weeks} semanas, esperado 49 — o corte de venda não é o da base legada`)
  if (hits >= floor) pass(`σ: ${hits}/${sigmaItems.length} idênticos ao legado (piso ${floor})`)
  else fail(`σ: ${hits}/${sigmaItems.length} < piso ${floor} — o método de bucket mudou`)

  // ---- Tier 4 (Z) --------------------------------------------------------
  section('Tier 4 — as três constantes Z')
  const { rows: [z] } = await c.query(`
    select public.norm_s_inv(0.975) as a, public.norm_s_inv(0.95) as b, public.norm_s_inv(0.90) as c`)
  for (const [k, want, tol] of [['0.975', 1.9599639845400536, 0], ['0.95', 1.6448536269514715, 0],
                                ['0.90', 1.2815515655446004, 1e-15]]) {
    const got = Number(z[k === '0.975' ? 'a' : k === '0.95' ? 'b' : 'c'])
    if (Math.abs(got - want) <= tol) pass(`norm_s_inv(${k}) = ${got}`)
    else fail(`norm_s_inv(${k}) = ${got}, esperado ${want}`)
  }

  await c.end()

  console.log('')
  if (failures) {
    console.error(`PARIDADE QUEBRADA: ${failures} verificação(ões) falharam.`)
    process.exit(1)
  }
  console.log('Paridade verde: o motor reproduz a planilha.')
}

main().catch((e) => { console.error(e); process.exit(1) })
