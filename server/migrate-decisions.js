// One-shot: rename existing session-log.md rows to decisions.md and ensure
// every workspace has a decisions.md row in outline form.
//
// Run with: node server/migrate-decisions.js

import { config } from 'dotenv'
config({ override: true })

import { createClient } from '@supabase/supabase-js'

const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY, {
  auth: { autoRefreshToken: false, persistSession: false }
})

// Rename session-log.md → decisions.md (keeps owner_id, content, history)
const { data: sessionLogs } = await supabase
  .from('memory_notes')
  .select('id, workspace_id, content')
  .eq('filename', 'session-log.md')

console.log(`Found ${sessionLogs?.length || 0} session-log row(s) to migrate`)

for (const row of sessionLogs || []) {
  // If content is empty/default, replace with the new outline template
  const isDefault = !row.content?.trim() ||
    /^# Session Log\s*$/i.test(row.content.trim())

  const newContent = isDefault
    ? '# Decisions & Actions\n\n## Decisions\n- _What\'s been decided. Outline form, one bullet each._\n\n## Actions\n- _What needs to happen next. Outline form. Add owner if known._\n'
    : row.content.replace(/^# Session Log/i, '# Decisions & Actions')

  const { error } = await supabase
    .from('memory_notes')
    .update({ filename: 'decisions.md', content: newContent, permission: 'edit-all' })
    .eq('id', row.id)

  if (error) console.error('  failed:', error.message)
  else console.log('  ✓ migrated row', row.id)
}

console.log('\n✓ Done. session-log.md is now decisions.md.')
