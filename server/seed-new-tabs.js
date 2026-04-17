// One-shot: seed the new Playbook + My Notes tabs for existing users/orgs/projects.
// Safe to re-run — uses insert-if-missing logic.
//
// Run with: node server/seed-new-tabs.js

import { config } from 'dotenv'
config({ override: true })

import { createClient } from '@supabase/supabase-js'

const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY, {
  auth: { autoRefreshToken: false, persistSession: false }
})

// ── Seed Playbook (org-level, edit-all) for every org ──────────────────────
const { data: orgs } = await supabase.from('organizations').select('id, name')
console.log(`Found ${orgs?.length || 0} org(s)`)

for (const org of orgs || []) {
  const { data: existing } = await supabase
    .from('org_memory_notes')
    .select('id')
    .eq('org_id', org.id)
    .eq('filename', 'playbook.md')
    .maybeSingle()

  if (existing) {
    console.log(`  - ${org.name}: playbook.md already exists, skip`)
    continue
  }

  const content = `# Playbook

How work actually happens here. Processes, approval paths, unwritten rules, timing gotchas.

## Examples to capture:
- What approvals are needed before a campaign goes live?
- What's the typical timing (legal review, creative review, QA)?
- Who has veto power on different things?
- Any unwritten rules ("no Friday launches", "seed test with Keyona first")?
- Cultural norms (how the team decides, how disagreements get resolved)?
`

  // Need an owner_id — use the first member of the org
  const { data: firstMember } = await supabase
    .from('org_members')
    .select('user_id')
    .eq('org_id', org.id)
    .limit(1)
    .single()

  if (!firstMember) {
    console.log(`  - ${org.name}: no members, skip`)
    continue
  }

  const { error } = await supabase.from('org_memory_notes').insert({
    org_id: org.id,
    filename: 'playbook.md',
    content,
    permission: 'edit-all',
    owner_id: firstMember.user_id
  })

  if (error) {
    console.error(`  - ${org.name}: insert failed:`, error.message)
  } else {
    console.log(`  - ${org.name}: playbook.md created`)
  }
}

// ── Seed My Notes (project-level, private) for every workspace member ──────
const { data: projects } = await supabase.from('projects').select('id, name')
console.log(`\nFound ${projects?.length || 0} workspace(s)`)

for (const ws of projects || []) {
  const { data: members } = await supabase
    .from('project_members')
    .select('user_id')
    .eq('project_id', ws.id)

  for (const m of members || []) {
    const { data: existing } = await supabase
      .from('memory_notes')
      .select('id')
      .eq('project_id', ws.id)
      .eq('filename', 'my-notes.md')
      .eq('owner_id', m.user_id)
      .maybeSingle()

    if (existing) {
      console.log(`  - ${ws.name} / ${m.user_id}: my-notes.md already exists, skip`)
      continue
    }

    const content = `# My Notes

Personal scratchpad — only you see this.

Jot down:
- Questions to ask someone later
- Reminders
- Half-baked thoughts about this project
- Personal TODOs
`

    const { error } = await supabase.from('memory_notes').insert({
      project_id: ws.id,
      filename: 'my-notes.md',
      content,
      visibility: 'private',
      permission: 'private',
      owner_id: m.user_id
    })

    if (error) {
      console.error(`  - ${ws.name} / ${m.user_id}: insert failed:`, error.message)
    } else {
      console.log(`  - ${ws.name} / ${m.user_id}: my-notes.md created`)
    }
  }
}

console.log('\n✓ Done.')
