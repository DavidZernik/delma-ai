// One-shot: ask Haiku to convert the existing Architecture diagram so each
// technical node is paired with a borderless "annotation" node containing
// the plain-english description. The pair is held in an invisible subgraph
// (direction LR) so the note sits to the RIGHT of its tech node.
//
// Run with: node server/add-floating-labels.js

import { config } from 'dotenv'
config({ override: true })

import { createClient } from '@supabase/supabase-js'

const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY, {
  auth: { autoRefreshToken: false, persistSession: false }
})

const { data: views } = await supabase.from('diagram_views').select('id, title, mermaid')

for (const v of views || []) {
  if (!v.mermaid?.trim()) continue
  console.log(`→ ${v.title}: rewriting with floating labels...`)

  const fenceMatch = v.mermaid.match(/```mermaid\n([\s\S]*?)\n```/)
  if (!fenceMatch) { console.log('  no mermaid fence found, skip'); continue }
  const mermaidOnly = fenceMatch[1]

  const res = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': process.env.ANTHROPIC_API_KEY,
      'anthropic-version': '2023-06-01'
    },
    body: JSON.stringify({
      model: 'claude-haiku-4-5',
      max_tokens: 3000,
      system: `You are rewriting a Mermaid flowchart so each technical node is paired with a "floating label" — a borderless annotation node containing a plain-english description, positioned NEXT TO the technical node.

Pattern for every node:

  subgraph pair_<id> [" "]
    direction LR
    <id>["<technical label>"]
    <id>_note["plain-english description"]:::note
  end

Then connect technical nodes to each other via their original IDs (NOT the subgraph IDs). Example:

  subgraph pair_auto [" "]
    direction LR
    Auto["Automation\\nBirthday_Daily_Send_Refresh\\n5 AM CT daily"]
    Auto_note["kicks off every morning"]:::note
  end
  subgraph pair_query [" "]
    direction LR
    Query["SQL: Birthday_Daily_Filter"]
    Query_note["narrows to today's birthdays"]:::note
  end
  Auto --> Query

At the END of the diagram add these style declarations:
  classDef note fill:transparent,stroke:transparent,color:#6B5A5A,font-style:italic,font-size:12px
  style pair_auto fill:transparent,stroke:transparent
  style pair_query fill:transparent,stroke:transparent
  ... etc for every subgraph ...

Rules:
- Description: 3-8 words, human, no jargon
- Keep all original edges between technical nodes
- Use the same flowchart direction (TD or LR) as the original
- For decision/diamond nodes, pair them too
- Return ONLY valid Mermaid syntax. No prose, no code fences.`,
      messages: [{
        role: 'user',
        content: `Rewrite this diagram with floating labels:\n\n${mermaidOnly}`
      }]
    })
  })

  if (!res.ok) { console.error(`  API ${res.status}:`, await res.text()); continue }
  const data = await res.json()
  let updated = data.content?.[0]?.text?.trim()
  if (!updated) { console.error('  empty response'); continue }
  updated = updated.replace(/^```(?:mermaid)?\n?/, '').replace(/\n?```$/, '')

  // Wrap back in the markdown document, replacing only the mermaid fence
  const newMermaid = v.mermaid.replace(/```mermaid\n[\s\S]*?\n```/, '```mermaid\n' + updated + '\n```')

  const { error } = await supabase
    .from('diagram_views')
    .update({ mermaid: newMermaid })
    .eq('id', v.id)

  if (error) console.error(`  failed:`, error.message)
  else console.log(`  ✓ rewrote, diagram block now ${updated.length} chars`)
}

console.log('\n✓ Done. Reload the Architecture tab to see the floating labels.')
