// One-time migration: pull the currently-configured SFMC creds out of
// Supabase (sfmc_accounts table, encrypted) and write them to the new
// local file at ~/.config/sfmc/.env. Run once, then the DB row becomes
// irrelevant for runtime — you can delete it whenever you're confident.
//
// Usage: node scripts/migrate-sfmc-to-local.js
//
// Safe: never overwrites an existing ~/.config/sfmc/.env unless you pass
// --force. Prints a preview of what would be written either way.

import { config } from 'dotenv'
config({ override: true })

import { createClient } from '@supabase/supabase-js'
import { readFileSync, existsSync } from 'node:fs'
import { decrypt } from '../server/lib/crypto.js'
import { saveSfmcEnv, CONFIG_PATHS } from '../server/lib/local-config.js'

const FORCE = process.argv.includes('--force')

const sb = createClient(
  process.env.SUPABASE_URL || process.env.VITE_SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY
)

const { data: rows, error } = await sb
  .from('sfmc_accounts')
  .select('*')
if (error) { console.error('Supabase error:', error.message); process.exit(1) }
if (!rows?.length) { console.error('No sfmc_accounts rows found.'); process.exit(2) }

const child = rows.find(r => r.bu_role === 'child') || rows[0]
const parent = rows.find(r => r.bu_role === 'parent')

const fields = {}
if (child) {
  fields.CLIENT_ID = decrypt(child.client_id_enc)
  fields.CLIENT_SECRET = decrypt(child.client_secret_enc)
  fields.ACCOUNT_ID = child.account_id || ''
  fields.AUTH_BASE_URL = child.auth_base_url || ''
  fields.REST_BASE_URL = child.rest_base_url || ''
  fields.SOAP_BASE_URL = child.soap_base_url || ''
  if (child.account_label) fields.CHILD_BU_LABEL = child.account_label
}
if (parent) {
  fields.PARENT_BU_CLIENT_ID = decrypt(parent.client_id_enc)
  fields.PARENT_BU_CLIENT_SECRET = decrypt(parent.client_secret_enc)
  fields.PARENT_BU_MID = parent.account_id || ''
  fields.PARENT_BU_AUTH_BASE_URL = parent.auth_base_url || ''
  fields.PARENT_BU_REST_BASE_URL = parent.rest_base_url || ''
  fields.PARENT_BU_SOAP_BASE_URL = parent.soap_base_url || ''
  if (parent.account_label) fields.PARENT_BU_LABEL = parent.account_label
}

console.log('Found', rows.length, 'SFMC account row(s):')
for (const r of rows) console.log(' -', r.bu_role, '(', r.account_label || 'unlabeled', ')')

console.log('\nWould write to', CONFIG_PATHS.sfmcEnv, '-- keys:')
for (const k of Object.keys(fields)) console.log(' ', k, '=', k.includes('SECRET') ? '<redacted>' : fields[k].slice(0, 40))

if (existsSync(CONFIG_PATHS.sfmcEnv) && !FORCE) {
  console.log('\n⚠  File already exists at', CONFIG_PATHS.sfmcEnv)
  console.log('   Re-run with --force to overwrite.')
  process.exit(0)
}

saveSfmcEnv(fields)
console.log('\n✓ Wrote', CONFIG_PATHS.sfmcEnv, '(chmod 0600)')
console.log('  Delma + the email builder will now read creds from here instead of Supabase.')
