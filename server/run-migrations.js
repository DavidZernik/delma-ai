// Run any new SQL migration files against the Supabase Postgres via DATABASE_URL.
// Tracks applied migrations in a __delma_migrations table to avoid re-running.
//
// Usage: node server/run-migrations.js

import { config } from 'dotenv'
config({ override: true })
import pkg from 'pg'
import { readdirSync, readFileSync } from 'fs'
import { resolve } from 'path'

const { Client } = pkg

if (!process.env.DATABASE_URL) {
  console.error('DATABASE_URL not set in .env — cannot run migrations.')
  process.exit(1)
}

const client = new Client({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false }
})

await client.connect()
console.log('✓ connected to Postgres')

// Ensure tracking table exists
await client.query(`
  CREATE TABLE IF NOT EXISTS __delma_migrations (
    filename text PRIMARY KEY,
    applied_at timestamptz DEFAULT now()
  )
`)

const dir = resolve('./supabase/migrations')
const files = readdirSync(dir).filter(f => f.endsWith('.sql')).sort()

const { rows: applied } = await client.query('SELECT filename FROM __delma_migrations')
const appliedSet = new Set(applied.map(r => r.filename))

let ranAny = false
for (const file of files) {
  if (appliedSet.has(file)) {
    console.log(`✓ ${file} (already applied)`)
    continue
  }
  console.log(`→ applying ${file}...`)
  const sql = readFileSync(resolve(dir, file), 'utf-8')
  try {
    await client.query('BEGIN')
    await client.query(sql)
    await client.query('INSERT INTO __delma_migrations(filename) VALUES ($1)', [file])
    await client.query('COMMIT')
    console.log(`  ✓ applied`)
    ranAny = true
  } catch (err) {
    await client.query('ROLLBACK')
    console.error(`  ✗ failed: ${err.message}`)
    // For "already exists" errors, mark as applied so future runs skip
    if (/already exists/i.test(err.message)) {
      console.log(`  (object already existed — marking as applied)`)
      await client.query('INSERT INTO __delma_migrations(filename) VALUES ($1) ON CONFLICT DO NOTHING', [file])
    } else {
      await client.end()
      process.exit(1)
    }
  }
}

if (!ranAny) console.log('\nAll migrations already applied.')
else console.log('\n✓ Done.')

await client.end()
