// One-shot: upgrade existing diagrams to use the new SFMC node vocabulary
// (typed shapes, color classDefs, optional emoji icons, layer subgraphs).
//
// Run with: node server/upgrade-diagram-style.js

import { config } from 'dotenv'
config({ override: true })

import { createClient } from '@supabase/supabase-js'

const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY, {
  auth: { autoRefreshToken: false, persistSession: false }
})

const SYSTEM_PROMPT = `You are upgrading a Mermaid diagram to use the SFMC visual vocabulary.

For every technical node, pick the right shape + class:

| Concept                          | Shape syntax        | classDef class |
|----------------------------------|---------------------|----------------|
| Data Extension                   | NodeId[(label)]     | :::de          |
| Source DE (read-only / external) | NodeId[(label)]     | :::deSource    |
| SQL / Query Activity             | NodeId[[label]]     | :::sql         |
| Automation                       | NodeId{{label}}     | :::automation  |
| Journey                          | NodeId([label])     | :::journey     |
| Email asset                      | NodeId[/label/]     | :::email       |
| CloudPage                        | NodeId[\\\\label\\\\]   | :::cloudpage   |
| Decision split                   | NodeId{label}       | :::decision    |
| Endpoint / Result                | NodeId([label])     | :::endpoint    |

Add an emoji at the START of each technical label:
- 💾 DE
- ⚙️ Automation
- 🔍 SQL
- ⚡ Journey
- 📧 Email
- 🌐 CloudPage
- 🔀 Decision

PRESERVE the existing floating-label pair structure:
- Each technical node lives inside its own subgraph pair_<id> with a _note
- The note styling stays unchanged (classDef note ...)

ADD layer subgraphs that group related nodes by role in the flow.
Examples: "Patient Source", "Daily Filter", "Send + Engagement",
"Quiz Capture", "Follow-up Routing".

At the END of the diagram include ALL of these classDefs:
  classDef de fill:#F2F6FA,stroke:#7FA0BD,stroke-width:1.5px,color:#0F0A0A
  classDef deSource fill:#EAF1F7,stroke:#7FA0BD,stroke-width:1.5px,color:#0F0A0A
  classDef sql fill:#FCF8E8,stroke:#C9B864,stroke-width:1.5px,color:#0F0A0A
  classDef automation fill:#F4F1EC,stroke:#A89887,stroke-width:1.5px,color:#0F0A0A
  classDef journey fill:#FBEBEB,stroke:#C28080,stroke-width:1.5px,color:#0F0A0A
  classDef email fill:#FAF1E5,stroke:#C9A878,stroke-width:1.5px,color:#0F0A0A
  classDef cloudpage fill:#F2EBF5,stroke:#A18BB5,stroke-width:1.5px,color:#0F0A0A
  classDef decision fill:#FFFFFF,stroke:#8F0000,stroke-width:2px,color:#0F0A0A
  classDef endpoint fill:#FFFFFF,stroke:#888,stroke-width:1.5px,color:#0F0A0A
  classDef note fill:transparent,stroke:transparent,color:#6B5A5A,font-style:italic,font-size:12px

For every layer subgraph add: style <layer_id> fill:transparent,stroke:#E8D8D2,stroke-dasharray:4 4
For every pair subgraph add: style <pair_id> fill:transparent,stroke:transparent

Return ONLY the upgraded Mermaid syntax. No prose, no code fences.`

const { data: views } = await supabase.from('diagram_views').select('id, title, mermaid')

for (const v of views || []) {
  if (!v.mermaid?.trim()) continue
  console.log(`→ ${v.title}: upgrading style...`)

  const fenceMatch = v.mermaid.match(/```mermaid\n([\s\S]*?)\n```/)
  if (!fenceMatch) { console.log('  no fence, skip'); continue }
  const original = fenceMatch[1]

  const res = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': process.env.ANTHROPIC_API_KEY,
      'anthropic-version': '2023-06-01'
    },
    body: JSON.stringify({
      model: 'claude-haiku-4-5',
      max_tokens: 4000,
      system: SYSTEM_PROMPT,
      messages: [{ role: 'user', content: `Upgrade this diagram:\n\n${original}` }]
    })
  })

  if (!res.ok) { console.error('  API error:', res.status, await res.text()); continue }
  const data = await res.json()
  let updated = data.content?.[0]?.text?.trim()
  if (!updated) { console.error('  empty response'); continue }
  updated = updated.replace(/^```(?:mermaid)?\n?/, '').replace(/\n?```$/, '')

  const newDoc = v.mermaid.replace(/```mermaid\n[\s\S]*?\n```/, '```mermaid\n' + updated + '\n```')

  const { error } = await supabase.from('diagram_views').update({ mermaid: newDoc }).eq('id', v.id)
  if (error) console.error('  save failed:', error.message)
  else console.log(`  ✓ upgraded — diagram now ${updated.length} chars`)
}

console.log('\n✓ Done. Reload the Architecture tab to see typed shapes + colors.')
