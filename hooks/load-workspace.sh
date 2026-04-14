#!/bin/bash
# Claude Code hook: loads Delma workspace context at session start.
# Add to your Claude Code settings.json hooks section.
# This script calls the Delma MCP server to get the current workspace state
# and outputs it so Claude has full context before the first message.

# The MCP server handles auth via service role key in .env
cd "$(dirname "$0")/.."
node -e "
import './server/lib/supabase.js'
import { readDiagramViews, readMemoryMap, listHistory } from './server/delma-state.js'

const workspaceId = process.env.DELMA_WORKSPACE_ID
const userId = process.env.DELMA_USER_ID

if (!workspaceId || !userId) {
  console.log('DELMA_WORKSPACE_ID and DELMA_USER_ID must be set.')
  process.exit(0)
}

const [views, memory, history] = await Promise.all([
  readDiagramViews(workspaceId, userId),
  readMemoryMap(workspaceId, userId),
  listHistory(workspaceId)
])

console.log('# Delma Workspace Context')
console.log('')

for (const view of views) {
  console.log('## ' + view.title)
  if (view.description) console.log(view.description)
  if (view.mermaid) console.log('\n\`\`\`mermaid\n' + view.mermaid.trim() + '\n\`\`\`')
  console.log('')
}

for (const [file, content] of Object.entries(memory)) {
  if (content?.trim()) {
    console.log('## ' + file)
    console.log(content.trim())
    console.log('')
  }
}
" 2>/dev/null
