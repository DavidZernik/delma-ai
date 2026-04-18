// Seed Emory's SFMC connections (parent + child BU) into the sfmc_accounts
// table for the Emory org. Reads creds from the existing local SFMC project
// .env files so secrets aren't duplicated by hand.
//
// Run: node scripts/seed-sfmc-accounts.js
//
// Idempotent — uses upsert keyed on (org_id, bu_role).

import { config } from 'dotenv'
import { createClient } from '@supabase/supabase-js'
import { readFileSync } from 'node:fs'
import { encrypt } from '../server/lib/crypto.js'

config()

const ORG_ID = '58e43330-c76c-474c-b89e-7a2d606a4a61' // Emory Healthcare
const SUBDOMAIN = 'mcvxtx2z6j0zm8sr3052pf8bh508'
const SFMC_PROJECTS_BASE = '/Users/davidzernik/Desktop/Emory Healthcare/all-salesforce-projects'

function readEnv(path) {
  const raw = readFileSync(path, 'utf-8')
  const out = {}
  for (const line of raw.split('\n')) {
    const m = line.match(/^([A-Z_][A-Z0-9_]*)=(.*)$/)
    if (m) out[m[1]] = m[2].replace(/^["']|["']$/g, '')
  }
  return out
}

async function main() {
  const sb = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY, {
    auth: { autoRefreshToken: false, persistSession: false }
  })

  // Child BU creds — every birthday-folder script uses CLIENT_ID/SECRET.
  const birthdayEnv = readEnv(`${SFMC_PROJECTS_BASE}/birthday/.env`)
  // Parent BU creds — only calendar-project's .env carries them.
  const calendarEnv = readEnv(`${SFMC_PROJECTS_BASE}/calendar-project/.env`)

  const accounts = [
    {
      bu_role: 'child',
      account_label: 'Emory Marketing BU',
      account_id: '514018883',
      client_id: birthdayEnv.CLIENT_ID,
      client_secret: birthdayEnv.CLIENT_SECRET
    },
    {
      bu_role: 'parent',
      account_label: 'Emory Parent BU',
      account_id: '514018310',
      client_id: calendarEnv.PARENT_BU_CLIENT_ID,
      client_secret: calendarEnv.PARENT_BU_CLIENT_SECRET
    }
  ]

  for (const a of accounts) {
    if (!a.client_id || !a.client_secret) {
      console.warn(`[seed] SKIP ${a.bu_role}: missing client_id or client_secret in source .env`)
      continue
    }
    const row = {
      org_id: ORG_ID,
      bu_role: a.bu_role,
      account_label: a.account_label,
      account_id: a.account_id,
      auth_base_url: `https://${SUBDOMAIN}.auth.marketingcloudapis.com`,
      rest_base_url: `https://${SUBDOMAIN}.rest.marketingcloudapis.com`,
      soap_base_url: `https://${SUBDOMAIN}.soap.marketingcloudapis.com`,
      is_sandbox: false,
      client_id_enc: encrypt(a.client_id),
      client_secret_enc: encrypt(a.client_secret),
      updated_at: new Date().toISOString()
    }

    const { data: existing } = await sb.from('sfmc_accounts')
      .select('id').eq('org_id', ORG_ID).eq('bu_role', a.bu_role).maybeSingle()

    if (existing) {
      const { error } = await sb.from('sfmc_accounts').update(row).eq('id', existing.id)
      if (error) { console.error(`[seed] update ${a.bu_role} failed:`, error.message); continue }
      console.log(`[seed] updated ${a.bu_role} BU (${a.account_label}, MID ${a.account_id})`)
    } else {
      const { error } = await sb.from('sfmc_accounts').insert(row)
      if (error) { console.error(`[seed] insert ${a.bu_role} failed:`, error.message); continue }
      console.log(`[seed] inserted ${a.bu_role} BU (${a.account_label}, MID ${a.account_id})`)
    }
  }
}

main().catch(err => { console.error(err); process.exit(1) })
