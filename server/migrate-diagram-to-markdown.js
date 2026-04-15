// One-shot migration: convert diagram_views rows from pure-Mermaid storage
// to markdown-with-inline-Mermaid. Combines the summary (walkthrough) and
// mermaid fields into a single markdown document stored in the mermaid field.
//
// After this, the Architecture tab is editable as one markdown blob — the
// prose and the diagram live together.
//
// Run with: node server/migrate-diagram-to-markdown.js

import { config } from 'dotenv'
config({ override: true })

import { createClient } from '@supabase/supabase-js'

const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY, {
  auth: { autoRefreshToken: false, persistSession: false }
})

const { data: views } = await supabase.from('diagram_views').select('id, title, mermaid, summary')

for (const v of views || []) {
  if (!v.mermaid?.trim()) continue

  // Skip if already in markdown format
  if (/^\s*(#|```mermaid)/.test(v.mermaid)) {
    console.log(`→ ${v.title}: already markdown, skip`)
    continue
  }

  console.log(`→ ${v.title}: migrating...`)

  // Strip any existing front-matter from the Mermaid
  const mermaidCode = v.mermaid.replace(/^---\n[\s\S]*?\n---\n?/, '').trim()
  const walkthrough = v.summary?.trim() || ''

  const unified = walkthrough
    ? `## How it works

${walkthrough}

## Diagram

\`\`\`mermaid
${mermaidCode}
\`\`\`
`
    : `## Diagram

\`\`\`mermaid
${mermaidCode}
\`\`\`
`

  const { error } = await supabase
    .from('diagram_views')
    .update({ mermaid: unified, summary: null })
    .eq('id', v.id)

  if (error) {
    console.error(`  FAILED:`, error.message)
  } else {
    console.log(`  ✓ migrated, newLen: ${unified.length}`)
  }
}

console.log('\n✓ Done. Diagrams now store markdown with inline Mermaid.')
