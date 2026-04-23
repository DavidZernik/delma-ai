import 'dotenv/config'
import { createClient } from '@supabase/supabase-js'
const s = createClient(process.env.VITE_SUPABASE_URL || process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY)
const { data } = await s.from('org_memory_notes').select('*').eq('filename','playbook.md')
for (const row of data) {
  console.log('── org', row.org_id, 'chars', row.content?.length)
  console.log(row.content)
  console.log('────────────────────────')
}
