// Retrieves an SFMC asset and dumps its 207 structure to see why Code View
// is empty in Content Builder. Usage: node scripts/diagnose-asset.js <assetId>
import 'dotenv/config'
import { createClient } from '@supabase/supabase-js'
import { decrypt } from '../server/lib/crypto.js'

const assetId = process.argv[2] || '267695'

const supabase = createClient(
  process.env.VITE_SUPABASE_URL || process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY
)

const { data: rows } = await supabase.from('sfmc_accounts').select('*').limit(1)
if (!rows?.length) { console.error('No SFMC account found'); process.exit(1) }
const r = rows[0]
const account = {
  auth_base_url: r.auth_base_url, rest_base_url: r.rest_base_url,
  client_id: decrypt(r.client_id_enc), client_secret: decrypt(r.client_secret_enc),
  account_id: r.account_id
}

async function token() {
  const r = await fetch(`${account.auth_base_url}/v2/token`, {
    method: 'POST', headers: {'Content-Type':'application/json'},
    body: JSON.stringify({ grant_type:'client_credentials', client_id:account.client_id, client_secret:account.client_secret, ...(account.account_id?{account_id:account.account_id}:{}) })
  })
  return (await r.json()).access_token
}

const t = await token()
const res = await fetch(`${account.rest_base_url}/asset/v1/content/assets/${assetId}`, {
  headers: { 'Authorization': `Bearer ${t}` }
})
const asset = await res.json()
console.log('status', res.status)
console.log('name', asset.name, 'customerKey', asset.customerKey)
console.log('assetType', asset.assetType)
console.log('template', JSON.stringify(asset.views?.html?.template, null, 2))
console.log('slots keys', Object.keys(asset.views?.html?.slots || {}))
const mainKey = Object.keys(asset.views?.html?.slots || {})[0]
const main = asset.views?.html?.slots?.[mainKey]
if (main) {
  console.log('inspecting slot:', mainKey)
  console.log('\n── slot.main.content ─────────────')
  console.log(main.content?.slice(0, 500))
  console.log('\n── slot.main.blocks keys ─────────')
  console.log(Object.keys(main.blocks || {}))
  const firstKey = Object.keys(main.blocks || {})[0]
  if (firstKey) {
    console.log('\n── first block', firstKey, '───')
    const b = main.blocks[firstKey]
    console.log('keys:', Object.keys(b))
    console.log('assetType', b.assetType)
    console.log('content len', (b.content||'').length, 'design len', (b.design||'').length)
    console.log('modelVersion', b.modelVersion, 'meta', JSON.stringify(b.meta))
  }
  console.log('\n── slot.main keys', Object.keys(main))
  console.log('slot.main.design len', (main.design||'').length)
}
console.log('\n── views.html.content length:', (asset.views?.html?.content || '').length)
console.log((asset.views?.html?.content || '(empty)').slice(0, 400))
console.log('\n── template.content length:', (asset.views?.html?.template?.content || '').length)
console.log('\n── top-level asset.content length:', (asset.content || '').length)
