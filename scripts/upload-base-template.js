// One-time setup: upload the v4.2 base HTML to SFMC as a Template asset
// (assetType 4). Records the resulting template ID so the email assembly
// module can reference it. Idempotent — finds an existing template by
// customerKey and skips creation if already present.
//
// Run: node scripts/upload-base-template.js [orgId]

import { config } from 'dotenv'
config({ override: true })

import { getSfmcAccountsForOrg } from '../server/lib/sfmc-account.js'
import * as sfmc from '../server/lib/sfmc-client.js'
import { BASE_TEMPLATE } from '../server/email-library/index.js'

const ORG_ID = process.argv[2] || '58e43330-c76c-474c-b89e-7a2d606a4a61'
const TEMPLATE_KEY = BASE_TEMPLATE.id

async function main() {
  const accounts = await getSfmcAccountsForOrg(ORG_ID)
  const acct = accounts.child || accounts.parent
  if (!acct) { console.error('No SFMC account for this org.'); process.exit(1) }
  console.log(`Uploading "${BASE_TEMPLATE.name}" to ${acct.bu_role} BU (${acct.label})…`)

  // Check if already uploaded — fetch by customerKey.
  const tokenRes = await fetch(`${acct.auth_base_url}/v2/token`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      grant_type: 'client_credentials',
      client_id: acct.client_id,
      client_secret: acct.client_secret,
      ...(acct.account_id ? { account_id: acct.account_id } : {})
    })
  })
  const token = (await tokenRes.json()).access_token
  const lookupRes = await fetch(`${acct.rest_base_url}/asset/v1/content/assets/query`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ query: { property: 'customerKey', simpleOperator: 'equals', value: TEMPLATE_KEY } })
  })
  const lookup = await lookupRes.json()
  if (lookup.items?.[0]) {
    console.log(`Already uploaded — template ID: ${lookup.items[0].id}`)
    console.log(`customerKey: ${lookup.items[0].customerKey}`)
    console.log('\nUse this template ID in the Create Email modal.')
    return
  }

  const result = await sfmc.createTemplate(acct, {
    name: BASE_TEMPLATE.name,
    customerKey: TEMPLATE_KEY,
    html: BASE_TEMPLATE.html
  })
  if (!result.ok) {
    console.error('Upload failed:', result.code, result.message)
    process.exit(2)
  }
  console.log(`Uploaded — template ID: ${result.templateId}`)
  console.log(`customerKey: ${result.customerKey}`)
  console.log('\nUse this template ID in the Create Email modal.')
}

main().catch(err => { console.error(err); process.exit(1) })
