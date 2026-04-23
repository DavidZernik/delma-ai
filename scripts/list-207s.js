// Find 207 emails in the tenant to compare to dztest123.
import 'dotenv/config'
import { createClient } from '@supabase/supabase-js'
import { decrypt } from '../server/lib/crypto.js'

const supabase = createClient(process.env.VITE_SUPABASE_URL || process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY)
const { data: rows } = await supabase.from('sfmc_accounts').select('*').limit(1)
const r = rows[0]
const account = { auth_base_url: r.auth_base_url, rest_base_url: r.rest_base_url, client_id: decrypt(r.client_id_enc), client_secret: decrypt(r.client_secret_enc), account_id: r.account_id }

const tr = await fetch(`${account.auth_base_url}/v2/token`, { method:'POST', headers:{'Content-Type':'application/json'}, body: JSON.stringify({grant_type:'client_credentials', client_id:account.client_id, client_secret:account.client_secret, ...(account.account_id?{account_id:account.account_id}:{})}) })
const token = (await tr.json()).access_token

const res = await fetch(`${account.rest_base_url}/asset/v1/content/assets/query`, {
  method:'POST', headers:{'Authorization':`Bearer ${token}`,'Content-Type':'application/json'},
  body: JSON.stringify({ query:{ property:'assetType.id', simpleOperator:'equal', value: 207 }, page:{ page:1, pageSize:20 } })
})
const data = await res.json()
console.log('status', res.status)
for (const a of (data.items||[])) {
  console.log(a.id, '│', a.name, '│', a.customerKey)
}
