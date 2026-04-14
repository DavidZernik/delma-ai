#!/bin/bash
# ──────────────────────────────────────────────────────────────────────────────
# Claude Code Hook: Load Delma workspace context at session start
# ──────────────────────────────────────────────────────────────────────────────
#
# This hook does two things:
#   1. Outputs the full workspace context to stdout (injected into Claude's
#      context window at session start — one-time, full detail)
#   2. Writes a summarized CLAUDE.md to the working directory (auto-loaded
#      by Claude Code on every turn — lightweight, always fresh)
#
# Add to your Claude Code settings.json hooks section.
# Requires: DELMA_WORKSPACE_ID, DELMA_USER_ID env vars
# ──────────────────────────────────────────────────────────────────────────────

cd "$(dirname "$0")/.."
node -e "
import { readDiagramViews, readMemoryMap, listHistory, getWorkspace } from './server/delma-state.js'
import { generateClaudeMd } from './server/lib/summarizer.js'
import { writeFile } from 'fs/promises'
import { resolve } from 'path'

const workspaceId = process.env.DELMA_WORKSPACE_ID
const userId = process.env.DELMA_USER_ID

if (!workspaceId || !userId) {
  console.log('DELMA_WORKSPACE_ID and DELMA_USER_ID must be set.')
  process.exit(0)
}

const [views, memory, ws] = await Promise.all([
  readDiagramViews(workspaceId, userId),
  readMemoryMap(workspaceId, userId),
  getWorkspace(workspaceId)
])

// Get org name
let orgName = ''
if (ws.org_id) {
  const { supabase } = await import('./server/lib/supabase.js')
  const { data: org } = await supabase.from('organizations').select('name').eq('id', ws.org_id).single()
  orgName = org?.name || ''
}

// 1. Output full context to stdout (one-time injection)
console.log('# Delma Workspace Context')
if (orgName) console.log('Organization: ' + orgName)
console.log('Workspace: ' + ws.name)
console.log('')

for (const view of views) {
  console.log('## ' + view.title)
  if (view.description) console.log(view.description)
  if (view.mermaid) console.log('\n' + view.mermaid.trim().replace(/^---\\n[\\s\\S]*?\\n---\\n?/, ''))
  console.log('')
}

const memMap = {}
for (const [file, content] of Object.entries(memory)) {
  if (content?.trim()) {
    console.log('## ' + file)
    console.log(content.trim())
    console.log('')
    memMap[file] = content
  }
}

// 2. Write summarized CLAUDE.md for always-loaded context
const claudeMd = await generateClaudeMd(views, memMap, orgName, ws.name)
const cwd = process.env.DELMA_PROJECT_DIR || process.cwd()
await writeFile(resolve(cwd, 'CLAUDE.md'), claudeMd, 'utf-8')
" 2>/dev/null
