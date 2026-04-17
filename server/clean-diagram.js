// One-shot cleanup: strip the stale people nodes (Keyona, David) that got
// mixed into the Architecture diagram by the earlier buggy version of the
// fact router. Replaces with the clean version.
//
// Run with: node server/clean-diagram.js

import { config } from 'dotenv'
config({ override: true })

import { createClient } from '@supabase/supabase-js'

const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY, {
  auth: { autoRefreshToken: false, persistSession: false }
})

const WORKSPACE_ID = 'a1b2c3d4-0000-0000-0000-000000000001'

const { data, error } = await supabase
  .from('diagram_views')
  .select('id, title, mermaid')
  .eq('project_id', WORKSPACE_ID)
  .eq('view_key', 'architecture')
  .single()

if (error) { console.error('fetch error:', error); process.exit(1) }

console.log('Before:')
console.log(data.mermaid)
console.log('---')

// Strip the people-related lines added by the old router bug
const cleaned = data.mermaid
  .split('\n')
  .filter(line => {
    const l = line.trim()
    // Remove lines that reference keyona/david as nodes or edges
    if (/^Keyona\[/i.test(l)) return false
    if (/^David\[/i.test(l)) return false
    if (/-->\s*Keyona\b/i.test(l)) return false
    if (/-->\s*David\b/i.test(l)) return false
    if (/^Owner\[/i.test(l)) return false
    if (/-->\s*Owner\b/i.test(l)) return false
    return true
  })
  .join('\n')

console.log('After:')
console.log(cleaned)
console.log('---')

const { error: updateErr } = await supabase
  .from('diagram_views')
  .update({ mermaid: cleaned, summary: null }) // null summary so it regenerates on next view
  .eq('id', data.id)

if (updateErr) { console.error('update error:', updateErr); process.exit(1) }
console.log('✓ Diagram cleaned and saved. Summary cleared — will regenerate on next view.')
