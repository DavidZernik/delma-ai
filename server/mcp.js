// ──────────────────────────────────────────────────────────────────────────────
// Delma MCP Server — Supabase backend
// ──────────────────────────────────────────────────────────────────────────────
//
// This runs as a stdio MCP server that Claude Code connects to.
// It gives Claude read/write access to the Delma workspace — diagrams,
// memory notes, and history — all stored in Supabase.
//
// Required env vars (set in .mcp.json):
//   DELMA_WORKSPACE_ID — UUID of the workspace to operate on
//   DELMA_USER_ID      — UUID of the authenticated user
//
// Permission enforcement:
//   Supabase RLS policies enforce access at the database level.
//   This server also checks permissions before writes and returns
//   helpful error messages (e.g. "you don't have edit access to this tab").
//
// ──────────────────────────────────────────────────────────────────────────────

import { config } from 'dotenv'
config({ override: true })

import { z } from 'zod'
import { McpServer, ResourceTemplate } from '@modelcontextprotocol/sdk/server/mcp.js'
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import { writeFile } from 'fs/promises'
import { resolve } from 'path'
import {
  createWorkspace,
  listWorkspaces,
  getWorkspace,
  readDiagramViews,
  getDiagramView,
  saveDiagramView,
  readMemoryMap,
  appendMemoryNote,
  listHistory,
  canEdit,
  getUserRole,
  logMcpCall,
  composeClaudeMd
} from './delma-state.js'
import { generateClaudeMd } from './lib/summarizer.js'

// ── Auto-summarizer ──────────────────────────────────────────────────────────
// After every write, re-summarize the workspace and write CLAUDE.md locally.
// This keeps the always-loaded context fresh without burning tokens on
// full tab content every turn.

async function refreshClaudeMd() {
  if (!activeWorkspaceId || !activeUserId) return
  console.log('[mcp] refreshClaudeMd starting, workspace:', activeWorkspaceId)
  const t0 = Date.now()
  try {
    const [views, memory] = await Promise.all([
      readDiagramViews(activeWorkspaceId, activeUserId),
      readMemoryMap(activeWorkspaceId, activeUserId)
    ])

    // Get workspace and org names for the summary header
    const ws = await getWorkspace(activeWorkspaceId)
    let orgName = ''
    if (ws.org_id) {
      const { supabase } = await import('./lib/supabase.js')
      const { data: org } = await supabase.from('organizations').select('name').eq('id', ws.org_id).single()
      orgName = org?.name || ''
    }

    const claudeMd = await generateClaudeMd(views, memory, orgName, ws.name)

    // Write to working directory so Claude Code auto-loads it
    const cwd = process.env.DELMA_PROJECT_DIR || process.cwd()
    await writeFile(resolve(cwd, 'CLAUDE.md'), claudeMd, 'utf-8')
    console.log('[mcp] refreshClaudeMd done in', Date.now() - t0, 'ms, length:', claudeMd.length)
  } catch (err) {
    console.error('[mcp] refreshClaudeMd failed:', err.message)
  }
}

const server = new McpServer({ name: 'delma', version: '2.0.0' })

let activeWorkspaceId = process.env.DELMA_WORKSPACE_ID || null
let activeUserId = process.env.DELMA_USER_ID || null

// ── Logging wrapper ──────────────────────────────────────────────────────────

function withLogging(toolName, handler) {
  return async (args) => {
    console.log(`[mcp] ${toolName} called`, JSON.stringify(args).substring(0, 200))
    const start = Date.now()
    let caughtError = null
    try {
      const result = await handler(args)
      console.log(`[mcp] ${toolName} done in ${Date.now() - start}ms`)
      return result
    } catch (e) {
      caughtError = e
      console.error(`[mcp] ${toolName} FAILED in ${Date.now() - start}ms:`, e.message)
      throw e
    } finally {
      void logMcpCall({
        workspaceId: activeWorkspaceId,
        userId: activeUserId,
        tool: toolName,
        input: args,
        durationMs: Date.now() - start,
        success: !caughtError,
        error: caughtError?.message
      })
    }
  }
}

function requireContext() {
  if (!activeWorkspaceId) throw new Error('No workspace set. Call open_workspace first or set DELMA_WORKSPACE_ID env var.')
  if (!activeUserId) throw new Error('No user set. Set DELMA_USER_ID env var.')
  return { workspaceId: activeWorkspaceId, userId: activeUserId }
}

// ── Tools ────────────────────────────────────────────────────────────────────

server.registerTool(
  'open_workspace',
  {
    title: 'Open Delma Workspace',
    description: 'Set the active workspace by name or ID. Creates it if it does not exist.',
    inputSchema: {
      name: z.string().optional().describe('Workspace name. Used to find or create.'),
      workspaceId: z.string().optional().describe('Workspace UUID. Takes precedence over name.'),
      userId: z.string().optional().describe('User UUID. Overrides DELMA_USER_ID env var.')
    }
  },
  withLogging('open_workspace', async ({ name, workspaceId, userId }) => {
    if (userId) activeUserId = userId
    if (!activeUserId) throw new Error('No user ID. Set DELMA_USER_ID env var or pass userId.')

    if (workspaceId) {
      activeWorkspaceId = workspaceId
      const ws = await getWorkspace(workspaceId)
      void refreshClaudeMd()  // summarize workspace on open
      return text({ ok: true, workspace: { id: ws.id, name: ws.name } })
    }

    if (name) {
      // Find by name
      const all = await listWorkspaces(activeUserId)
      const found = all.find(w => w.name.toLowerCase() === name.toLowerCase())
      if (found) {
        activeWorkspaceId = found.id
        void refreshClaudeMd()  // summarize workspace on open
        return text({ ok: true, workspace: { id: found.id, name: found.name } })
      }
      // Create
      const ws = await createWorkspace(name, activeUserId)
      activeWorkspaceId = ws.id
      void refreshClaudeMd()  // summarize new workspace
      return text({ ok: true, created: true, workspace: { id: ws.id, name: ws.name } })
    }

    throw new Error('Provide name or workspaceId.')
  })
)

server.registerTool(
  'get_workspace_state',
  {
    title: 'Get Workspace State',
    description: 'Read the full Delma workspace: diagram views, memory notes, and history.',
    inputSchema: {}
  },
  withLogging('get_workspace_state', async () => {
    const { workspaceId, userId } = requireContext()
    const [views, memory, history] = await Promise.all([
      readDiagramViews(workspaceId, userId),
      readMemoryMap(workspaceId, userId),
      listHistory(workspaceId)
    ])
    return text({ workspaceId, views, memory, history })
  })
)

server.registerTool(
  'list_diagram_views',
  {
    title: 'List Diagram Views',
    description: 'List available Mermaid diagram views in the workspace.',
    inputSchema: {}
  },
  withLogging('list_diagram_views', async () => {
    const { workspaceId, userId } = requireContext()
    const views = await readDiagramViews(workspaceId, userId)
    // Include permission level so Claude knows what's editable
    return text(views.map(({ view_key, title, kind, description, summary, visibility, permission }) => ({
      view_key, title, kind, description, summary, visibility, permission
    })))
  })
)

server.registerTool(
  'get_diagram_view',
  {
    title: 'Get Diagram View',
    description: 'Read one Mermaid diagram view by key.',
    inputSchema: {
      viewKey: z.string().describe('View key (e.g. "architecture", "org")')
    }
  },
  withLogging('get_diagram_view', async ({ viewKey }) => {
    const { workspaceId, userId } = requireContext()
    const view = await getDiagramView(workspaceId, viewKey, userId)
    return text(view)
  })
)

server.registerTool(
  'save_diagram_view',
  {
    title: 'Save Diagram View',
    description: 'Update a Mermaid diagram view and write a history snapshot.',
    inputSchema: {
      viewKey: z.string().describe('View key (e.g. "architecture", "org")'),
      title: z.string().optional(),
      description: z.string().optional(),
      summary: z.string().optional(),
      mermaid: z.string().optional(),
      reason: z.string().optional()
    }
  },
  withLogging('save_diagram_view', async ({ viewKey, title, description, summary, mermaid, reason }) => {
    const { workspaceId, userId } = requireContext()

    // Check permission before writing
    const existing = await getDiagramView(workspaceId, viewKey, userId)
    const role = await getUserRole(workspaceId, userId)
    if (!canEdit(existing.permission, existing.owner_id, userId, role)) {
      throw new Error(`No edit access to "${existing.title}" (permission: ${existing.permission}). Only ${existing.permission === 'view-all' ? 'admins' : 'the owner'} can edit this tab.`)
    }

    const updates = {}
    if (title !== undefined) updates.title = title
    if (description !== undefined) updates.description = description
    if (summary !== undefined) updates.summary = summary
    if (mermaid !== undefined) updates.mermaid = mermaid
    const view = await saveDiagramView(workspaceId, viewKey, updates, userId, reason)
    void refreshClaudeMd()  // async — don't block the response
    return text({ ok: true, view })
  })
)

server.registerTool(
  'append_memory_note',
  {
    title: 'Append Memory Note',
    description: 'Append text to a project-level memory file (environment.md, session-log.md, or my-notes.md). For People / Playbook (org-level), use sync_conversation_summary.',
    inputSchema: {
      file: z.enum(['environment.md', 'session-log.md', 'my-notes.md']),
      note: z.string(),
      heading: z.string().optional()
    }
  },
  withLogging('append_memory_note', async ({ file, note, heading }) => {
    const { workspaceId, userId } = requireContext()

    // Check permission before writing
    // Note: appendMemoryNote creates the note if it doesn't exist yet,
    // so we only check permission if there's an existing note.
    const { supabase: sb } = await import('./lib/supabase.js')
    const { data: existing } = await sb
      .from('memory_notes')
      .select('permission, owner_id')
      .eq('workspace_id', workspaceId)
      .eq('filename', file)
      .limit(1)
      .single()

    if (existing) {
      const role = await getUserRole(workspaceId, userId)
      if (!canEdit(existing.permission, existing.owner_id, userId, role)) {
        throw new Error(`No edit access to "${file}" (permission: ${existing.permission}).`)
      }
    }

    await appendMemoryNote(workspaceId, file, note, heading, userId)
    void refreshClaudeMd()  // async — don't block the response
    return text({ ok: true, file })
  })
)

server.registerTool(
  'compose_claude_md',
  {
    title: 'Compose CLAUDE.md',
    description: 'Generate the CLAUDE.md content from current workspace state. Returns the composed markdown.',
    inputSchema: {}
  },
  withLogging('compose_claude_md', async () => {
    const { workspaceId, userId } = requireContext()
    const md = await composeClaudeMd(workspaceId, userId)
    return text({ ok: true, length: md.length, content: md })
  })
)

server.registerTool(
  'list_history',
  {
    title: 'List History',
    description: 'List workspace history snapshots.',
    inputSchema: {}
  },
  withLogging('list_history', async () => {
    const { workspaceId } = requireContext()
    const history = await listHistory(workspaceId)
    return text(history)
  })
)

// ── Conversation Sync ───────────────────────────────────────────────────────

server.registerTool(
  'sync_conversation_summary',
  {
    title: 'Sync Conversation Summary',
    description: `Sync facts from the current conversation into the Delma workspace.
Call this every few exchanges when project-relevant information comes up:
people, decisions, architecture details, environment IDs, key logic, or status changes.
Pass a plain-English summary — the tool handles routing to the right tabs and patching.`,
    inputSchema: {
      summary: z.string().describe('Plain-English summary of facts, decisions, people, or details discussed in the conversation. Be specific — include names, IDs, roles, system details.')
    }
  },
  withLogging('sync_conversation_summary', async ({ summary }) => {
    const { workspaceId, userId } = requireContext()
    console.log('[mcp sync] summary:', summary.substring(0, 100), '...')

    // Read current workspace state
    const [views, memory] = await Promise.all([
      readDiagramViews(workspaceId, userId),
      readMemoryMap(workspaceId, userId)
    ])

    // Build a snapshot of current content for DeepSeek
    const tabContents = {}
    for (const v of views) {
      if (v.mermaid) tabContents[`diagram:${v.view_key}`] = { type: 'mermaid', content: v.mermaid, id: v.id, table: 'diagram_views' }
    }
    for (const [filename, content] of Object.entries(memory)) {
      if (content) tabContents[`memory:${filename}`] = { type: 'markdown', content, filename, table: 'memory_notes' }
    }

    // Also read org-level notes if we have an org
    const ws = await getWorkspace(workspaceId)
    if (ws.org_id) {
      const { supabase: sb } = await import('./lib/supabase.js')
      const { data: orgNotes } = await sb.from('org_memory_notes').select('*').eq('org_id', ws.org_id)
      for (const note of (orgNotes || [])) {
        if (note.content) tabContents[`org:${note.filename}`] = { type: 'markdown', content: note.content, id: note.id, table: 'org_memory_notes' }
      }
    }

    // Build the context string — tab names + first 500 chars of each
    const tabSummary = Object.entries(tabContents).map(([key, t]) =>
      `### ${key} (${t.type})\n${t.content.substring(0, 500)}${t.content.length > 500 ? '...' : ''}`
    ).join('\n\n')

    // Ask DeepSeek which tabs to update and how
    const apiKey = process.env.DEEPSEEK_API_KEY
    if (!apiKey) return text({ ok: false, error: 'DEEPSEEK_API_KEY not configured' })

    const res = await fetch('https://api.deepseek.com/v1/chat/completions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${apiKey}` },
      body: JSON.stringify({
        model: 'deepseek-chat',
        temperature: 0,
        max_tokens: 1000,
        messages: [{
          role: 'user',
          content: `You are a workspace sync assistant. A user just discussed the following in a conversation:

"${summary}"

Here are the current workspace tabs and their content:

${tabSummary}

Determine which tabs should be updated with new information from the summary.
Only update tabs where the summary contains NEW information not already captured.
Skip tabs where nothing relevant was discussed.

Respond with a JSON array of updates:
[{"tab": "memory:people.md", "patches": [{"find": "exact text", "replace": "updated text"}]}]

For appending new content, use: {"find": "", "replace": "new text to append"}
Return [] if nothing needs updating. Return ONLY valid JSON, no explanation.`
        }]
      })
    })

    console.log('[mcp sync] DeepSeek response:', res.status)
    if (!res.ok) return text({ ok: false, error: `DeepSeek returned ${res.status}` })

    const data = await res.json()
    let raw = data.choices?.[0]?.message?.content?.trim()
    console.log('[mcp sync] raw patches:', raw?.substring(0, 200))
    if (!raw) return text({ ok: false, error: 'No response from DeepSeek' })

    // Strip code fences
    raw = raw.replace(/^```(?:json)?\n?/, '').replace(/\n?```$/, '')

    let updates
    try {
      updates = JSON.parse(raw)
    } catch {
      return text({ ok: false, error: 'Invalid JSON from DeepSeek', raw: raw.substring(0, 200) })
    }

    if (!Array.isArray(updates) || !updates.length) {
      return text({ ok: true, message: 'No updates needed', tabsChecked: Object.keys(tabContents).length })
    }

    // Apply patches
    const { supabase: sb } = await import('./lib/supabase.js')
    const results = []

    for (const update of updates) {
      const tab = tabContents[update.tab]
      if (!tab || !update.patches?.length) continue

      let content = tab.content
      for (const p of update.patches) {
        if (!p.find && p.replace) {
          content = content.trimEnd() + '\n' + p.replace
        } else if (content.includes(p.find)) {
          content = content.replace(p.find, p.replace)
        }
      }

      // Save to Supabase
      if (tab.table === 'diagram_views') {
        await sb.from('diagram_views').update({ mermaid: content }).eq('id', tab.id)
      } else if (tab.table === 'memory_notes') {
        await sb.from('memory_notes').update({ content }).eq('workspace_id', workspaceId).eq('filename', tab.filename)
      } else if (tab.table === 'org_memory_notes') {
        await sb.from('org_memory_notes').update({ content }).eq('id', tab.id)
      }

      console.log('[mcp sync] patched:', update.tab, 'patches:', update.patches.length)
      results.push({ tab: update.tab, patchesApplied: update.patches.length })
    }

    void refreshClaudeMd()
    return text({ ok: true, updated: results, tabsChecked: Object.keys(tabContents).length })
  })
)

// ── Resource ─────────────────────────────────────────────────────────────────

server.registerResource(
  'workspace',
  new ResourceTemplate('delma://workspace/{viewKey}', { list: undefined }),
  { title: 'Delma Diagram View', description: 'Read a diagram view as a resource.' },
  async (uri, { viewKey }) => {
    const { workspaceId, userId } = requireContext()
    const view = await getDiagramView(workspaceId, viewKey, userId)
    return { contents: [{ uri: uri.href, text: JSON.stringify(view, null, 2) }] }
  }
)

// ── Helper ───────────────────────────────────────────────────────────────────

function text(obj) {
  return { content: [{ type: 'text', text: JSON.stringify(obj, null, 2) }] }
}

// ── Start ────────────────────────────────────────────────────────────────────

const transport = new StdioServerTransport()
await server.connect(transport)
