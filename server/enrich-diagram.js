// One-shot: enrich the current Architecture diagram with plain-english
// em-dash labels on each node. Called once to backfill; the router
// going forward will produce diagrams with these labels by default.
//
// Run with: node server/enrich-diagram.js

import { config } from 'dotenv'
config({ override: true })

import { createClient } from '@supabase/supabase-js'

const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY, {
  auth: { autoRefreshToken: false, persistSession: false }
})

const { data: views } = await supabase.from('diagram_views').select('id, title, mermaid')

for (const v of views || []) {
  if (!v.mermaid?.trim()) continue
  console.log(`→ Enriching ${v.title}...`)

  const res = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': process.env.ANTHROPIC_API_KEY,
      'anthropic-version': '2023-06-01'
    },
    body: JSON.stringify({
      model: 'claude-haiku-4-5',
      max_tokens: 2000,
      system: `You are editing a Mermaid flowchart. Add a plain-english description as the LAST line of every node's label, prefixed with "— " (em-dash + space).

Rules:
- 3-8 words. Human. No jargon.
- Describes what THIS node does or represents, in terms a non-technical PM would understand.
- If a node already has a "— ..." line, keep it (only rewrite if clearly outdated).
- Preserve ALL existing node content, ALL edges, ALL styling.
- The em-dash line goes at the END of each node's label, on its own line.

Example:
  Auto["Automation
  Birthday_Daily_Send_Refresh
  5 AM CT daily
  — kicks off every morning"]

Return ONLY the updated Mermaid. No prose, no code fences.`,
      messages: [{
        role: 'user',
        content: `Add plain-english "— " descriptions to every node in this diagram:\n\n${v.mermaid}`
      }]
    })
  })

  if (!res.ok) {
    console.error(`  FAILED: ${res.status} ${await res.text()}`)
    continue
  }

  const data = await res.json()
  let updated = data.content?.[0]?.text?.trim()
  if (!updated) { console.error('  empty response'); continue }
  updated = updated.replace(/^```(?:mermaid)?\n?/, '').replace(/\n?```$/, '')

  await supabase.from('diagram_views').update({ mermaid: updated, summary: null }).eq('id', v.id)
  console.log(`  ✓ enriched, newLen: ${updated.length}`)
}

console.log('\n✓ Done. Summary cleared — walkthrough will regenerate on next view.')
