#!/usr/bin/env node
// audit-grants.mjs — falha o build se `anon` alcançar qualquer coisa.
//
// Existe porque o erro é fácil de cometer e impossível de ver: em Postgres,
// `revoke ... from public` NÃO tira o privilégio de `anon`, que o herdou por
// outro caminho. Uma função SECURITY DEFINER exposta a `anon` é acesso ao banco
// inteiro sem login — e nada na tela muda quando isso acontece.
//
//   node scripts/audit-grants.mjs

import pg from 'pg'

const DB_URL = process.env.PARITY_DB_URL ?? 'postgresql://postgres:postgres@127.0.0.1:54322/postgres'

const c = new pg.Client({ connectionString: DB_URL })
await c.connect()

let bad = 0

// ---- funções alcançáveis por anon -----------------------------------------
const { rows: fns } = await c.query(`
  select p.proname, pg_get_function_identity_arguments(p.oid) as args,
         p.prosecdef as security_definer
  from pg_proc p
  join pg_namespace n on n.oid = p.pronamespace
  where n.nspname = 'public'
    and has_function_privilege('anon', p.oid, 'execute')
  order by p.proname
`)

if (fns.length) {
  bad += fns.length
  console.error(`\n${fns.length} função(ões) executáveis por anon:`)
  for (const f of fns) {
    console.error(`  ✗ ${f.proname}(${f.args})${f.security_definer ? '  [SECURITY DEFINER]' : ''}`)
  }
} else {
  console.log('✓ nenhuma função em public é executável por anon')
}

// ---- tabelas alcançáveis por anon -----------------------------------------
const { rows: tbls } = await c.query(`
  select c.relname, array_agg(priv order by priv) as privs
  from pg_class c
  join pg_namespace n on n.oid = c.relnamespace
  cross join unnest(array['select','insert','update','delete']) as priv
  where n.nspname = 'public' and c.relkind in ('r', 'v', 'm', 'p')
    and has_table_privilege('anon', c.oid, priv)
  group by c.relname
  order by c.relname
`)

if (tbls.length) {
  bad += tbls.length
  console.error(`\n${tbls.length} tabela(s) acessíveis por anon:`)
  for (const t of tbls) console.error(`  ✗ ${t.relname}: ${t.privs.join(', ')}`)
} else {
  console.log('✓ nenhuma tabela em public é acessível por anon')
}

// ---- tabelas de tenant sem RLS --------------------------------------------
// Uma tabela com `company_id` e sem RLS é multi-tenancy só no diagrama.
const { rows: noRls } = await c.query(`
  select c.relname
  from pg_class c
  join pg_namespace n on n.oid = c.relnamespace
  where n.nspname = 'public' and c.relkind = 'r' and not c.relrowsecurity
    and exists (
      select 1 from pg_attribute a
      where a.attrelid = c.oid and a.attname = 'company_id' and not a.attisdropped
    )
  order by c.relname
`)

if (noRls.length) {
  bad += noRls.length
  console.error(`\n${noRls.length} tabela(s) com company_id e sem RLS:`)
  for (const t of noRls) console.error(`  ✗ ${t.relname}`)
} else {
  console.log('✓ toda tabela com company_id tem RLS ligada')
}

// ---- tabelas com RLS ligada e nenhuma política -----------------------------
// Nem sempre é erro: `integration_secrets` é assim de propósito, para que só o
// service_role alcance. Mas é sempre uma decisão, então tem que aparecer.
const { rows: noPolicy } = await c.query(`
  select c.relname
  from pg_class c
  join pg_namespace n on n.oid = c.relnamespace
  where n.nspname = 'public' and c.relkind = 'r' and c.relrowsecurity
    and not exists (select 1 from pg_policy p where p.polrelid = c.oid)
  order by c.relname
`)

if (noPolicy.length) {
  console.log(`\nℹ ${noPolicy.length} tabela(s) com RLS e zero políticas (só service_role alcança):`)
  for (const t of noPolicy) console.log(`    ${t.relname}`)
}

await c.end()

console.log('')
if (bad) {
  console.error(`AUDITORIA DE GRANTS QUEBRADA: ${bad} problema(s).`)
  process.exit(1)
}
console.log('Auditoria de grants limpa.')
