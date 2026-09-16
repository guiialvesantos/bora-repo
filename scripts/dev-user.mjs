#!/usr/bin/env node
/**
 * Cria um usuário logável no Supabase local e o torna dono da empresa que o
 * harness de paridade semeou. Só para desenvolvimento — o `parity.mjs` insere
 * direto em `auth.users` porque só precisa de um `sub` para o JWT falso; aqui
 * precisamos de senha, e senha quem sabe fazer é o GoTrue.
 *
 * Uso: node scripts/dev-user.mjs [email] [senha]
 */
import pg from 'pg'

const API = 'http://127.0.0.1:54321'
const SERVICE_ROLE = process.env.SUPABASE_SERVICE_ROLE_KEY
  ?? 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZS1kZW1vIiwicm9sZSI6InNlcnZpY2Vfcm9sZSIsImV4cCI6MTk4MzgxMjk5Nn0.EGIM96RAZx35lJzdJsyH-qQwv8Hdp7fsn3W0YpN81IU'

const EMAIL = process.argv[2] ?? 'dev@stock.local'
const PASSWORD = process.argv[3] ?? 'stock1234'

const res = await fetch(`${API}/auth/v1/admin/users`, {
  method: 'POST',
  headers: {
    apikey: SERVICE_ROLE,
    Authorization: `Bearer ${SERVICE_ROLE}`,
    'Content-Type': 'application/json',
  },
  body: JSON.stringify({ email: EMAIL, password: PASSWORD, email_confirm: true }),
})

const body = await res.json()
if (!res.ok && body.error_code !== 'email_exists') {
  console.error(body)
  process.exit(1)
}

const c = new pg.Client('postgresql://postgres:postgres@127.0.0.1:54322/postgres')
await c.connect()

const { rows: [user] } = await c.query('select id from auth.users where email = $1', [EMAIL])
const { rows: companies } = await c.query('select id, name from public.companies order by created_at')

for (const co of companies) {
  await c.query(
    `insert into public.company_members (company_id, user_id, role)
     values ($1, $2, 'owner')
     on conflict (company_id, user_id) do update set role = 'owner'`,
    [co.id, user.id],
  )
  console.log(`  ${co.name} → owner`)
}

await c.end()
console.log(`\n${EMAIL} / ${PASSWORD}`)
