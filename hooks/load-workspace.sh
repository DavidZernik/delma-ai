#!/bin/bash
# ──────────────────────────────────────────────────────────────────────────────
# Claude Code Hook: Load Delma workspace context at session start
# ──────────────────────────────────────────────────────────────────────────────
#
# Reads the user's active workspace from Supabase (no hardcoded workspace ID
# needed). Falls back to DELMA_WORKSPACE_ID env var if set.
#
# Outputs:
#   1. Full workspace + org context to stdout (one-time injection)
#   2. Summarized CLAUDE.md to the working directory (every-turn context)
#
# Requires: DELMA_USER_ID env var (or DELMA_WORKSPACE_ID as fallback)
# ──────────────────────────────────────────────────────────────────────────────

cd "$(dirname "$0")/.."
node -e "
import { supabase } from './server/lib/supabase.js'
import { readDiagramViews, readMemoryMap, getWorkspace } from './server/delma-state.js'
import { generateClaudeMd } from './server/lib/summarizer.js'
import { writeFile } from 'fs/promises'
import { resolve } from 'path'

const userId = process.env.DELMA_USER_ID
let workspaceId = process.env.DELMA_WORKSPACE_ID

if (!userId) {
  console.log('DELMA_USER_ID must be set.')
  process.exit(0)
}

// If no workspace ID, read the user's active workspace from Supabase
if (!workspaceId) {
  const { data: memberships } = await supabase
    .from('org_members')
    .select('active_workspace_id, org_id, organizations(name)')
    .eq('user_id', userId)
    .not('active_workspace_id', 'is', null)
    .limit(1)

  if (memberships?.length) {
    workspaceId = memberships[0].active_workspace_id
  } else {
    // Fall back to first workspace the user belongs to
    const { data: wm } = await supabase
      .from('workspace_members')
      .select('workspace_id')
      .eq('user_id', userId)
      .limit(1)
    workspaceId = wm?.[0]?.workspace_id
  }
}

if (!workspaceId) {
  console.log('No active workspace found. Open one in the Delma web app first.')
  process.exit(0)
}

const [views, memory, ws] = await Promise.all([
  readDiagramViews(workspaceId, userId),
  readMemoryMap(workspaceId, userId),
  getWorkspace(workspaceId)
])

// Get org name and org-level notes
let orgName = ''
let orgMemory = {}
if (ws.org_id) {
  const { data: org } = await supabase.from('organizations').select('name').eq('id', ws.org_id).single()
  orgName = org?.name || ''
  const { data: orgNotes } = await supabase.from('org_memory_notes').select('filename, content').eq('org_id', ws.org_id)
  for (const note of (orgNotes || [])) orgMemory[note.filename] = note.content
}

// 1. Output full context to stdout
console.log('# Delma Workspace Context')
if (orgName) console.log('Organization: ' + orgName)
console.log('Workspace: ' + ws.name)
console.log('')

// Org-level tabs first
for (const [file, content] of Object.entries(orgMemory)) {
  if (content?.trim()) {
    console.log('## ' + file + ' (org-level)')
    console.log(content.trim())
    console.log('')
  }
}

// Project diagrams
for (const view of views) {
  console.log('## ' + view.title)
  if (view.description) console.log(view.description)
  if (view.mermaid) console.log(view.mermaid.trim().replace(/^---\\n[\\s\\S]*?\\n---\\n?/, ''))
  console.log('')
}

// Project memory
for (const [file, content] of Object.entries(memory)) {
  if (content?.trim()) {
    console.log('## ' + file)
    console.log(content.trim())
    console.log('')
  }
}

// 2. Write summarized CLAUDE.md
const allMemory = { ...orgMemory, ...memory }
const claudeMd = await generateClaudeMd(views, allMemory, orgName, ws.name)
const cwd = process.env.DELMA_PROJECT_DIR || process.cwd()
await writeFile(resolve(cwd, 'CLAUDE.md'), claudeMd, 'utf-8')
" 2>/dev/null
