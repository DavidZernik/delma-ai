// One-shot: upgrade existing inline mermaid blocks in People and Playbook
// to use the appropriate visual vocabulary for each tab.
//
// Run with: node server/upgrade-org-tabs.js

import { config } from 'dotenv'
config({ override: true })
import { createClient } from '@supabase/supabase-js'

const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY, {
  auth: { autoRefreshToken: false, persistSession: false }
})

const PEOPLE_PROMPT = `You are upgrading inline Mermaid diagrams inside a markdown document about TEAM PEOPLE and ORG STRUCTURE.

CRITICAL SYNTAX: ALWAYS wrap labels in DOUBLE QUOTES inside shape brackets.
Otherwise emoji + spaces break the lexer. Example:
  Keyona(["👔 Keyona Abbott<br/>Manager / PM"]):::manager

PEOPLE NODE VOCABULARY:

EVERY person/manager/stakeholder node label STARTS with an outlined
placeholder avatar span. Required HTML inside the label:

  <span class='avatar-placeholder'></span>

Full node syntax:

| Concept                | Correct full syntax                                                                                |
|------------------------|-----------------------------------------------------------------------------------------------------|
| Person (IC)            | NodeId(["<span class='avatar-placeholder'></span>Name<br/>Role"]):::person                          |
| Manager / leader       | NodeId(["<span class='avatar-placeholder'></span>Name<br/>Title"]):::manager                        |
| Stakeholder / external | NodeId[/"<span class='avatar-placeholder'></span>Name<br/>Role"\\\\]:::stakeholder                    |
| Team / group           | NodeId[("<span class='avatar-placeholder'></span>Team Name")]:::team                                |
| Vendor / contractor    | NodeId[/"<span class='avatar-placeholder'></span>Name"/]:::vendor                                   |

Do NOT use emoji icons (👤 👔 🤝 👥 🏢) — the placeholder circle replaces them.

REQUIRED classDef block at the END of every diagram:
  classDef person fill:#FAF6F0,stroke:#B8A88F,stroke-width:1.5px,color:#0F0A0A
  classDef manager fill:#F5EFE6,stroke:#9F8C70,stroke-width:1.5px,color:#0F0A0A
  classDef stakeholder fill:#F4F0EA,stroke:#A89887,stroke-width:1.5px,stroke-dasharray:4 3,color:#0F0A0A
  classDef team fill:#FBEBEB,stroke:#C28080,stroke-width:1.5px,color:#0F0A0A
  classDef vendor fill:#F2EBF5,stroke:#A18BB5,stroke-width:1.5px,color:#0F0A0A

PRESERVE the rest of the markdown document verbatim — only rewrite the
\`\`\`mermaid block(s). Reporting lines: solid arrows top-down. Collab: -.->.

Return the COMPLETE markdown document with upgraded mermaid blocks.
No code fences around the whole response.`

const PLAYBOOK_PROMPT = `You are upgrading inline Mermaid diagrams inside a markdown PLAYBOOK document about business processes, approvals, unwritten rules.

CRITICAL SYNTAX: ALWAYS wrap labels in DOUBLE QUOTES inside shape brackets.

PLAYBOOK NODE VOCABULARY:

| Concept                | Correct full syntax                                |
|------------------------|-----------------------------------------------------|
| Process step           | NodeId["📝 step name"]:::step                       |
| Approval gate          | NodeId{"🚦 approval needed?"}:::approval            |
| Wait / time delay      | NodeId{{"⏳ 48h wait"}}:::wait                       |
| Action / outcome       | NodeId(["✅ action"]):::action                      |
| Document / policy      | NodeId[/"📄 policy name"/]:::doc                    |
| Hard rule / blocker    | NodeId{"🚫 rule"}:::rule                            |

REQUIRED classDef block at the END of every diagram:
  classDef step fill:#F4F1EC,stroke:#A89887,stroke-width:1.5px,color:#0F0A0A
  classDef approval fill:#FAF1E5,stroke:#C9A878,stroke-width:1.5px,color:#0F0A0A
  classDef wait fill:#F2F6FA,stroke:#7FA0BD,stroke-width:1.5px,stroke-dasharray:4 3,color:#0F0A0A
  classDef action fill:#FFFFFF,stroke:#888,stroke-width:1.5px,color:#0F0A0A
  classDef doc fill:#FCF8E8,stroke:#C9B864,stroke-width:1.5px,color:#0F0A0A
  classDef rule fill:#FFFFFF,stroke:#8F0000,stroke-width:2px,color:#0F0A0A

PRESERVE the rest of the markdown document verbatim — only rewrite the
\`\`\`mermaid block(s). If the document doesn't have one yet but the prose
describes a clear process flow, ADD an inline mermaid block in this style.

Return the COMPLETE markdown document. No outer code fences.`

async function callHaiku(systemPrompt, userContent) {
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
      system: systemPrompt,
      messages: [{ role: 'user', content: userContent }]
    })
  })
  if (!res.ok) throw new Error(`API ${res.status}: ${await res.text()}`)
  const data = await res.json()
  let out = data.content?.[0]?.text?.trim()
  out = out.replace(/^```(?:markdown)?\n?/, '').replace(/\n?```$/, '')
  return out
}

const { data: notes } = await supabase
  .from('org_memory_notes')
  .select('id, filename, content')
  .in('filename', ['people.md', 'playbook.md'])

for (const n of notes || []) {
  if (!n.content?.trim()) { console.log(`→ ${n.filename}: empty, skip`); continue }
  console.log(`→ ${n.filename}: upgrading...`)

  const prompt = n.filename === 'people.md' ? PEOPLE_PROMPT : PLAYBOOK_PROMPT
  try {
    const upgraded = await callHaiku(prompt, n.content)
    if (!upgraded || upgraded.length < 20) { console.log('  empty result, skip'); continue }
    const { error } = await supabase.from('org_memory_notes').update({ content: upgraded }).eq('id', n.id)
    if (error) console.error('  save failed:', error.message)
    else console.log(`  ✓ upgraded — ${n.content.length} → ${upgraded.length} chars`)
  } catch (err) {
    console.error('  failed:', err.message)
  }
}

console.log('\n✓ Done. Reload People and Playbook tabs to see new visuals.')
