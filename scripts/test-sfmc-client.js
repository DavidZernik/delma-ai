// Live integration test for server/lib/sfmc-client.js.
// Exercises every operation against the real Emory Healthcare SFMC account,
// creates a throwaway DE (`delma_sdk_test`), and cleans up when done.
// Safe: no emails, no journeys, no sends — just DE + query-activity scaffolding.
//
// Run: node scripts/test-sfmc-client.js [orgId]
//   orgId defaults to Emory Healthcare (58e43330-c76c-474c-b89e-7a2d606a4a61)

import { config } from 'dotenv'
config({ override: true })

import { getSfmcAccountsForOrg } from '../server/lib/sfmc-account.js'
import * as sfmc from '../server/lib/sfmc-client.js'

const ORG_ID = process.argv[2] || '58e43330-c76c-474c-b89e-7a2d606a4a61'
const TEST_KEY = 'delma_sdk_test'

const results = []
function step(name, result) {
  const ok = result?.ok === true
  results.push({ name, ok, code: result?.code, message: result?.message, extra: ok ? pick(result, ['customerKey', 'deId', 'count', 'queryId', 'automationId', 'inserted', 'name']) : null })
  const badge = ok ? 'PASS' : 'FAIL'
  console.log(`[${badge}] ${name}${ok ? '' : ` — ${result?.code || '?'}: ${result?.message || ''}`}`)
  if (!ok && result?.raw) console.log(`        raw (first 400): ${String(result.raw).slice(0, 400)}`)
}
function pick(obj, keys) {
  const out = {}
  for (const k of keys) if (obj[k] !== undefined) out[k] = obj[k]
  return out
}

async function main() {
  console.log(`\n=== SFMC client integration test against org ${ORG_ID.slice(0, 8)} ===\n`)

  const accounts = await getSfmcAccountsForOrg(ORG_ID)
  const acct = accounts.child || accounts.parent
  if (!acct) {
    console.error('No SFMC account found for this org. Bailing.')
    process.exit(1)
  }
  console.log(`Using ${acct.bu_role} BU (${acct.label}, subdomain ${(acct.rest_base_url || '').match(/^https?:\/\/([^.]+)\./)?.[1]})\n`)

  // ── Cleanup any prior test residue ────────────────────────────────────
  console.log('Pre-cleanup: removing prior test DE if it exists…')
  const preClean = await sfmc.deleteDataExtension(acct, { customerKey: TEST_KEY })
  console.log(`  → ${preClean.ok ? 'removed' : `not present (${preClean.code || preClean.message})`}\n`)

  // ── 1. Create DE ──────────────────────────────────────────────────────
  const create = await sfmc.createDataExtension(acct, {
    name: TEST_KEY,
    customerKey: TEST_KEY,
    description: 'Throwaway DE created by delma-ai integration test',
    fields: [
      { name: 'SubscriberKey', type: 'Text', length: 254, isPrimaryKey: true, isRequired: true },
      { name: 'EmailAddress', type: 'EmailAddress' },
      { name: 'TestDate', type: 'Date' }
    ]
  })
  step('createDataExtension', create)
  if (!create.ok) { console.log('\nCannot continue without DE. Exiting.'); process.exit(1) }

  // ── 2. List DEs filtered by our key ───────────────────────────────────
  const list = await sfmc.listDataExtensions(acct, { namePattern: TEST_KEY, limit: 5 })
  step('listDataExtensions', list)

  // ── 3. Get the DE metadata + fields ───────────────────────────────────
  const get = await sfmc.getDataExtension(acct, { customerKey: TEST_KEY })
  step('getDataExtension', get)
  if (get.ok) {
    console.log(`        fields: ${(get.fields || []).map(f => `${f.name}:${f.type}`).join(', ')}`)
  }

  // ── 4. Insert one row ─────────────────────────────────────────────────
  const insert = await sfmc.insertRows(acct, {
    customerKey: TEST_KEY,
    rows: [
      { keys: { SubscriberKey: 'test-subscriber-1' }, values: { EmailAddress: 'test@example.com', TestDate: '2026-04-22' } }
    ]
  })
  step('insertRows', insert)

  // ── 5. Create a no-op query activity ──────────────────────────────────
  // Query from _Subscribers (system DE present in every SFMC instance) with
  // WHERE 1=0 so the result is empty. SFMC rejects an Overwrite where the
  // target DE self-references in FROM, so we read from something else.
  const query = await sfmc.createQueryActivity(acct, {
    name: `${TEST_KEY}_query`,
    key: `${TEST_KEY}_query`,
    targetDE: TEST_KEY,
    sql: `SELECT TOP 0 SubscriberKey, EmailAddress, CAST(GETDATE() AS date) AS TestDate FROM _Subscribers WHERE 1=0`,
    updateType: 'Overwrite'
  })
  step('createQueryActivity', query)

  // ── 6. Cleanup: delete query activity (via REST) then DE ──────────────
  console.log('\nCleanup:')
  if (query.ok && query.queryId) {
    // Query activities use REST DELETE /automation/v1/queries/{id}
    // Not wrapped in a client op — do it inline for cleanup.
    try {
      const r = await fetch(`${acct.rest_base_url}/automation/v1/queries/${encodeURIComponent(query.queryId)}`, {
        method: 'DELETE',
        headers: { 'Authorization': `Bearer ${await tokenFor(acct)}` }
      })
      console.log(`  query activity delete: ${r.ok ? 'ok' : `failed (${r.status})`}`)
    } catch (e) {
      console.log(`  query activity delete: threw (${e.message})`)
    }
  }
  const del = await sfmc.deleteDataExtension(acct, { customerKey: TEST_KEY })
  step('deleteDataExtension', del)

  // ── Summary ───────────────────────────────────────────────────────────
  const passed = results.filter(r => r.ok).length
  const total = results.length
  console.log(`\n=== ${passed}/${total} passed ===`)
  results.filter(r => !r.ok).forEach(r => {
    console.log(`  ✗ ${r.name}: ${r.code || '?'} — ${r.message || ''}`)
  })
  process.exit(passed === total ? 0 : 2)
}

// Tiny helper: the client caches tokens internally, but for the cleanup
// fetch above we need one outside the client. Just mint a new one.
async function tokenFor(acct) {
  const res = await fetch(`${acct.auth_base_url}/v2/token`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      grant_type: 'client_credentials',
      client_id: acct.client_id,
      client_secret: acct.client_secret,
      ...(acct.account_id ? { account_id: acct.account_id } : {})
    })
  })
  return (await res.json()).access_token
}

main().catch(err => {
  console.error('\nTest harness crashed:', err)
  process.exit(1)
})
