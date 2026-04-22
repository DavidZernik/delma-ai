// End-to-end test for the email create pipeline. Bypasses the HTTP layer
// (no auth token needed) and hits the assembly + sfmc-client path directly.
// Creates a real email in SFMC named "delma_test_email_YYYYMMDD", logs the
// asset ID + deep link, and cleans up after a 2-second delay.
//
// Run: node scripts/test-create-email.js [orgId]

import { config } from 'dotenv'
config({ override: true })

import { getSfmcAccountsForOrg } from '../server/lib/sfmc-account.js'
import * as sfmc from '../server/lib/sfmc-client.js'
import { assemble207, validate207 } from '../server/lib/sfmc-email-assembly.js'
import { BASE_TEMPLATE } from '../server/email-library/index.js'

const ORG_ID = process.argv[2] || '58e43330-c76c-474c-b89e-7a2d606a4a61'
const NAME = `delma_test_email_${new Date().toISOString().slice(0, 10).replace(/-/g, '')}`

async function main() {
  const accounts = await getSfmcAccountsForOrg(ORG_ID)
  const acct = accounts.child || accounts.parent
  if (!acct) { console.error('No SFMC account.'); process.exit(1) }
  console.log(`Using ${acct.bu_role} BU (${acct.label}).\n`)

  // 1. Look up template ID by customerKey
  console.log(`1. Looking up template by customerKey "${BASE_TEMPLATE.id}"…`)
  const tokenRes = await fetch(`${acct.auth_base_url}/v2/token`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ grant_type: 'client_credentials', client_id: acct.client_id, client_secret: acct.client_secret })
  })
  const token = (await tokenRes.json()).access_token
  const lookup = await (await fetch(`${acct.rest_base_url}/asset/v1/content/assets/query`, {
    method: 'POST', headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ query: { property: 'customerKey', simpleOperator: 'equals', value: BASE_TEMPLATE.id } })
  })).json()
  const templateId = lookup.items?.[0]?.id
  if (!templateId) { console.error(`Template "${BASE_TEMPLATE.id}" not found in SFMC. Run upload-base-template.js first.`); process.exit(2) }
  console.log(`   template ID: ${templateId}\n`)

  // 2. Find a folder to drop the email in — use the first content-builder folder
  console.log('2. Fetching folder tree…')
  const foldersRes = await (await fetch(`${acct.rest_base_url}/asset/v1/content/categories?$pagesize=50`, {
    headers: { Authorization: `Bearer ${token}` }
  })).json()
  const folder = foldersRes.items?.find(f => f.parentId === 0) || foldersRes.items?.[0]
  if (!folder) { console.error('No folders returned.'); process.exit(2) }
  console.log(`   picked folder: "${folder.name}" (id ${folder.id})\n`)

  // 3. Assemble a test email with 2 blocks
  console.log('3. Assembling 207 JSON with HB11 + HB14 blocks…')
  const payload = assemble207({
    name: NAME,
    subject: 'Test subject — delma integration',
    preheader: '',
    categoryId: folder.id,
    templateId,
    blocks: [
      { id: 'HB11', vars: {
        background_image_url: 'https://placehold.co/620x317.png',
        headline: 'Welcome to the Delma email builder',
        body_1: 'This is an end-to-end test email.',
        body_2: 'If you can see this in SFMC, the pipeline works.',
        button_label: 'Learn more',
        button_url: 'https://example.com'
      }},
      { id: 'HB14', vars: {
        icon_image_url: 'https://placehold.co/80x80.png',
        headline: 'Second block',
        body: 'Testing block ordering and assembly.',
        button_label: 'CTA',
        button_url: 'https://example.com'
      }}
    ]
  })
  const v = validate207(payload)
  console.log(`   validation: ${v.ok ? 'PASS' : 'FAIL'}${v.ok ? '' : ' — ' + v.errors.join(', ')}\n`)
  if (!v.ok) process.exit(3)

  // 4. POST to SFMC
  console.log('4. POSTing to SFMC /asset/v1/content/assets/…')
  const result = await sfmc.createEmailAsset(acct, payload)
  if (!result.ok) { console.error(`   FAILED: ${result.code} — ${result.message}`); process.exit(4) }
  console.log(`   ✓ created — assetId: ${result.assetId}, customerKey: ${result.customerKey}`)
  console.log(`   deep link: https://mc.s11.exacttarget.com/cloud/#app/Content%20Builder/${result.assetId}\n`)

  // 5. Verify by fetching back
  console.log('5. Verifying by fetching the asset back…')
  const verify = await (await fetch(`${acct.rest_base_url}/asset/v1/content/assets/${result.assetId}`, {
    headers: { Authorization: `Bearer ${token}` }
  })).json()
  const slot = verify.views?.html?.slots?.main
  const blockKeys = Object.keys(slot?.blocks || {})
  console.log(`   slot blocks: ${blockKeys.length}`)
  console.log(`   slot.content length: ${slot?.content?.length || 0} chars`)
  console.log(`   subjectline: "${verify.views?.subjectline?.content}"`)
  console.log(`   template.id: ${verify.views?.html?.template?.id}\n`)

  // 6. Cleanup
  console.log('6. Cleanup: deleting the test email…')
  const del = await sfmc.deleteAsset(acct, { assetId: result.assetId })
  console.log(`   ${del.ok ? 'deleted' : 'failed: ' + del.message}\n`)

  console.log('=== END TO END: PASS ===')
}

main().catch(err => { console.error('\nFAIL:', err.message || err); process.exit(1) })
