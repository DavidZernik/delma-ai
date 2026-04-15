// One-shot: strip "— description" lines from inside Mermaid node labels.
// The plain-english explanation now lives in the "## How it works" prose
// at the top of the architecture document, not inside the diagram nodes.
//
// Run with: node server/strip-emdash.js

import { config } from 'dotenv'
config({ override: true })

import { createClient } from '@supabase/supabase-js'

const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY, {
  auth: { autoRefreshToken: false, persistSession: false }
})

const { data: views } = await supabase.from('diagram_views').select('id, title, mermaid')

for (const v of views || []) {
  if (!v.mermaid?.trim()) continue

  // Strip the em-dash trailing lines. They show up in two forms:
  //   - inline literal newline inside a "..." label
  //   - escaped \n
  // We remove the "\n— ..." (or literal newline + "— ...") segment that
  // appears at the end of any node label.
  const cleaned = v.mermaid
    // \n— anything until closing quote
    .replace(/\\n— [^"\n]*"/g, '"')
    // literal newline em-dash line followed by closing quote
    .replace(/\n\s*— [^"\n]*"/g, '"')

  if (cleaned === v.mermaid) {
    console.log(`→ ${v.title}: no em-dash lines found, skip`)
    continue
  }

  const { error } = await supabase
    .from('diagram_views')
    .update({ mermaid: cleaned })
    .eq('id', v.id)

  if (error) console.error(`  failed:`, error.message)
  else console.log(`→ ${v.title}: stripped, newLen ${cleaned.length} (was ${v.mermaid.length})`)
}

console.log('\n✓ Done. Em-dash labels removed from inside nodes.')
