// ──────────────────────────────────────────────────────────────────────────────
// Delma MCP Server — Supabase backend
// ──────────────────────────────────────────────────────────────────────────────
//
// This runs as a stdio MCP server that Claude Code connects to.
// It gives Claude read/write access to the Delma workspace — diagrams,
// memory notes, and history — all stored in Supabase.
//
// Required env vars (set in .mcp.json):
//   DELMA_PROJECT_ID — UUID of the workspace to operate on
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
  createProject,
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
import { applyOpsToTab, parseTabKey } from './lib/apply-op.js'
import { supabase as sbRoot } from './lib/supabase.js'

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

let activeWorkspaceId = process.env.DELMA_PROJECT_ID || null
let activeUserId = process.env.DELMA_USER_ID || null

// ── Logging wrapper ──────────────────────────────────────────────────────────

// Tools that actually mutate project/org state. Used to tag logs so you can
// grep for writes vs reads.
const WRITE_TOOLS = new Set([
  'append_memory_note', 'compose_claude_md',
  'delma_add_person', 'delma_remove_person', 'delma_set_role', 'delma_set_manager',
  'delma_add_reporting_line', 'delma_remove_reporting_line',
  'delma_add_playbook_rule',
  'delma_add_decision', 'delma_supersede_decision',
  'delma_add_action', 'delma_complete_action', 'delma_complete_action_by_text',
  'delma_append_my_note',
  'delma_set_environment_key',
  'delma_arch_add_node', 'delma_arch_move_node', 'delma_arch_remove_node',
  'delma_arch_set_node_kind', 'delma_arch_set_node_label', 'delma_arch_set_node_note',
  'delma_arch_add_edge', 'delma_arch_remove_edge',
  'delma_arch_add_layer', 'delma_arch_remove_layer', 'delma_arch_set_prose',
  'sync_conversation_summary', 'save_diagram_view'
])

function withLogging(toolName, handler) {
  return async (args) => {
    const tag = WRITE_TOOLS.has(toolName) ? '[delma WRITE]' : '[mcp read]'
    console.log(`${tag} ${toolName} called`, JSON.stringify(args).substring(0, 200))
    const start = Date.now()
    let caughtError = null
    try {
      const result = await handler(args)
      const resultSummary = typeof result === 'string'
        ? `${result.length} chars`
        : result && typeof result === 'object'
          ? JSON.stringify(result).substring(0, 150)
          : 'ok'
      console.log(`${tag} ${toolName} done in ${Date.now() - start}ms →`, resultSummary)
      return result
    } catch (e) {
      caughtError = e
      console.error(`${tag} ${toolName} FAILED in ${Date.now() - start}ms:`, e.message)
      throw e
    } finally {
      void logMcpCall({
        projectId: activeWorkspaceId,
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
  if (!activeWorkspaceId) throw new Error('No workspace set. Call open_workspace first or set DELMA_PROJECT_ID env var.')
  if (!activeUserId) throw new Error('No user set. Set DELMA_USER_ID env var.')
  return { projectId: activeWorkspaceId, userId: activeUserId }
}

// ── Tools ────────────────────────────────────────────────────────────────────

server.registerTool(
  'open_workspace',
  {
    title: 'Open Delma Workspace',
    description: 'Set the active workspace by name or ID. Creates it if it does not exist.',
    inputSchema: {
      name: z.string().optional().describe('Workspace name. Used to find or create.'),
      projectId: z.string().optional().describe('Workspace UUID. Takes precedence over name.'),
      userId: z.string().optional().describe('User UUID. Overrides DELMA_USER_ID env var.')
    }
  },
  withLogging('open_workspace', async ({ name, projectId, userId }) => {
    if (userId) activeUserId = userId
    if (!activeUserId) throw new Error('No user ID. Set DELMA_USER_ID env var or pass userId.')

    if (projectId) {
      activeWorkspaceId = projectId
      const ws = await getWorkspace(projectId)
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
      const ws = await createProject(name, activeUserId)
      activeWorkspaceId = ws.id
      void refreshClaudeMd()  // summarize new workspace
      return text({ ok: true, created: true, workspace: { id: ws.id, name: ws.name } })
    }

    throw new Error('Provide name or projectId.')
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
    const { projectId, userId } = requireContext()
    const [views, memory, history] = await Promise.all([
      readDiagramViews(projectId, userId),
      readMemoryMap(projectId, userId),
      listHistory(projectId)
    ])
    return text({ projectId, views, memory, history })
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
    const { projectId, userId } = requireContext()
    const views = await readDiagramViews(projectId, userId)
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
    const { projectId, userId } = requireContext()
    const view = await getDiagramView(projectId, viewKey, userId)
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
    const { projectId, userId } = requireContext()

    // Check permission before writing
    const existing = await getDiagramView(projectId, viewKey, userId)
    const role = await getUserRole(projectId, userId)
    if (!canEdit(existing.permission, existing.owner_id, userId, role)) {
      throw new Error(`No edit access to "${existing.title}" (permission: ${existing.permission}). Only ${existing.permission === 'view-all' ? 'admins' : 'the owner'} can edit this tab.`)
    }

    const updates = {}
    if (title !== undefined) updates.title = title
    if (description !== undefined) updates.description = description
    if (summary !== undefined) updates.summary = summary
    if (mermaid !== undefined) updates.mermaid = mermaid
    const view = await saveDiagramView(projectId, viewKey, updates, userId, reason)
    void refreshClaudeMd()  // async — don't block the response
    return text({ ok: true, view })
  })
)

server.registerTool(
  'append_memory_note',
  {
    title: 'Append Memory Note',
    description: 'LEGACY free-form append. Prefer typed ops: delma_add_decision / delma_add_action for decisions.md, delma_set_environment_key for environment.md, delma_append_my_note for my-notes.md. Use this only when the typed ops do not fit (e.g. unstructured prose).',
    inputSchema: {
      file: z.enum(['environment.md', 'decisions.md', 'my-notes.md']),
      note: z.string(),
      heading: z.string().optional()
    }
  },
  withLogging('append_memory_note', async ({ file, note, heading }) => {
    const { projectId, userId } = requireContext()

    // Check permission before writing
    // Note: appendMemoryNote creates the note if it doesn't exist yet,
    // so we only check permission if there's an existing note.
    const { supabase: sb } = await import('./lib/supabase.js')
    const { data: existing } = await sb
      .from('memory_notes')
      .select('permission, owner_id')
      .eq('project_id', projectId)
      .eq('filename', file)
      .limit(1)
      .single()

    if (existing) {
      const role = await getUserRole(projectId, userId)
      if (!canEdit(existing.permission, existing.owner_id, userId, role)) {
        throw new Error(`No edit access to "${file}" (permission: ${existing.permission}).`)
      }
    }

    await appendMemoryNote(projectId, file, note, heading, userId)
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
    const { projectId, userId } = requireContext()
    const md = await composeClaudeMd(projectId, userId)
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
    const { projectId } = requireContext()
    const history = await listHistory(projectId)
    return text(history)
  })
)

// ── Typed-op tools (structured tabs) ───────────────────────────────────────
// Each tool applies ONE op to a known tab. Deterministic mutation + render.
// Claude Desktop picks the right tool from the conversation — no full rewrites.

async function getActiveOrgId() {
  const { projectId } = requireContext()
  const { data: ws } = await sbRoot.from('projects').select('org_id').eq('id', projectId).single()
  if (!ws?.org_id) throw new Error('workspace has no org_id')
  return ws.org_id
}

async function runOp(tabKey, op, args) {
  const { projectId, userId } = requireContext()
  const orgId = tabKey.startsWith('org:') ? await getActiveOrgId() : null
  const scope = parseTabKey(tabKey, { projectId, orgId, userId })
  if (!scope) throw new Error(`not a structured tab: ${tabKey}`)
  // Membership check — same protection /api/op enforces. Stops a misconfigured
  // DELMA_USER_ID from writing into a workspace/org the user doesn't belong to.
  if (scope.kind === 'org') {
    const { data: m } = await sbRoot.from('org_members').select('role').eq('user_id', userId).eq('org_id', orgId).maybeSingle()
    if (!m) throw new Error(`user ${userId.slice(0, 8)} is not a member of org ${orgId.slice(0, 8)}`)
  } else if (scope.kind === 'project') {
    const { data: m } = await sbRoot.from('project_members').select('role').eq('user_id', userId).eq('project_id', projectId).maybeSingle()
    if (!m) throw new Error(`user ${userId.slice(0, 8)} is not a member of workspace ${projectId.slice(0, 8)}`)
  }
  const result = await applyOpsToTab(sbRoot, scope, [{ op, args }])
  void refreshClaudeMd()
  return text({ ok: true, applied: result.applied, errors: result.errors })
}

// People ────────────────────────────────────────────────────────────────────

server.registerTool('delma_add_person', {
  title: 'Add Person',
  description: 'Add a team member, manager, stakeholder, team, or vendor to the People org chart.',
  inputSchema: {
    name: z.string().describe('Full name, e.g. "Keyona Abbott"'),
    role: z.string().optional().describe('Role or title, e.g. "Manager / PM"'),
    kind: z.enum(['person', 'manager', 'stakeholder', 'team', 'vendor']).optional().describe('Node kind. Defaults to "person".'),
    reports_to: z.string().optional().describe('Name of the person this one reports to. Must already exist.')
  }
}, withLogging('delma_add_person', (args) => runOp('org:people.md', 'add_person', args)))

server.registerTool('delma_set_role', {
  title: 'Set Person Role',
  description: 'Change a person\'s role/title on the People tab.',
  inputSchema: {
    person: z.string().describe('Name of the person'),
    role: z.string().describe('New role / title')
  }
}, withLogging('delma_set_role', (args) => runOp('org:people.md', 'set_role', args)))

server.registerTool('delma_remove_person', {
  title: 'Remove Person',
  description: 'Remove a person (and their reporting lines) from the People tab.',
  inputSchema: { name: z.string() }
}, withLogging('delma_remove_person', (args) => runOp('org:people.md', 'remove_person', args)))

server.registerTool('delma_add_reporting_line', {
  title: 'Add Reporting Line',
  description: 'Wire "from" reports to "to" (to is the manager). Additive — keeps any existing managers. Use set_manager for replacement.',
  inputSchema: {
    from: z.string().describe('Person who reports'),
    to: z.string().describe('Manager they report to')
  }
}, withLogging('delma_add_reporting_line', (args) => runOp('org:people.md', 'add_reporting_line', args)))

server.registerTool('delma_remove_reporting_line', {
  title: 'Remove Reporting Line',
  description: 'Unwire a specific reporting line. Use when a manager is removed but the report stays under someone else.',
  inputSchema: { from: z.string(), to: z.string() }
}, withLogging('delma_remove_reporting_line', (args) => runOp('org:people.md', 'remove_reporting_line', args)))

server.registerTool('delma_set_manager', {
  title: 'Set Manager (replace)',
  description: 'Replace ALL of person\'s managers with the named manager. Use for "X reports to Y instead of Z".',
  inputSchema: { person: z.string(), manager: z.string() }
}, withLogging('delma_set_manager', (args) => runOp('org:people.md', 'set_manager', args)))

// Playbook ───────────────────────────────────────────────────────────────────

server.registerTool('delma_add_playbook_rule', {
  title: 'Add Playbook Rule',
  description: 'Add a business process rule, unwritten norm, or timing gotcha to the Playbook.',
  inputSchema: {
    text: z.string().describe('The rule, one sentence, e.g. "No launches on Fridays"'),
    section: z.string().optional().describe('Optional section heading to group under')
  }
}, withLogging('delma_add_playbook_rule', (args) => runOp('org:playbook.md', 'add_playbook_rule', args)))

// Environment ───────────────────────────────────────────────────────────────

server.registerTool('delma_set_environment_key', {
  title: 'Set Environment Key',
  description: 'Record an SFMC ID, DE name, journey/automation key, or other technical config value.',
  inputSchema: {
    key: z.string().describe('Identifier name, e.g. "Sender Profile ID"'),
    value: z.string().describe('The value'),
    note: z.string().optional().describe('Optional context')
  }
}, withLogging('delma_set_environment_key', (args) => runOp('memory:environment.md', 'set_environment_key', args)))

// Decisions + Actions ───────────────────────────────────────────────────────

server.registerTool('delma_add_decision', {
  title: 'Add Decision',
  description: 'Record a decision made on this project.',
  inputSchema: {
    text: z.string().describe('The decision, one sentence'),
    owner: z.string().optional().describe('Who made / owns the decision')
  }
}, withLogging('delma_add_decision', (args) => runOp('memory:decisions.md', 'add_decision', args)))

server.registerTool('delma_add_action', {
  title: 'Add Action Item',
  description: 'Record an action item / todo.',
  inputSchema: {
    text: z.string(),
    owner: z.string().optional(),
    due: z.string().optional().describe('Due date / timing (free text)')
  }
}, withLogging('delma_add_action', (args) => runOp('memory:decisions.md', 'add_action', args)))

server.registerTool('delma_complete_action', {
  title: 'Mark Action Done',
  description: 'Mark an action item complete by id.',
  inputSchema: { id: z.string().describe('Action id (from delma_add_action or get_workspace_state)') }
}, withLogging('delma_complete_action', (args) => runOp('memory:decisions.md', 'complete_action', args)))

server.registerTool('delma_complete_action_by_text', {
  title: 'Mark Action Done by Text',
  description: 'Mark an action complete by fuzzy text match (use when you don\'t have the id).',
  inputSchema: { text: z.string().describe('Text or keywords from the action — e.g. "set up storage bucket"') }
}, withLogging('delma_complete_action_by_text', (args) => runOp('memory:decisions.md', 'complete_action_by_text', args)))

server.registerTool('delma_supersede_decision', {
  title: 'Supersede Decision',
  description: 'Mark an old decision as superseded and record the new one. Preserves the audit trail (vs. removing).',
  inputSchema: {
    id: z.string().describe('id of the decision being superseded'),
    new_text: z.string().describe('the new decision'),
    owner: z.string().optional()
  }
}, withLogging('delma_supersede_decision', (args) => runOp('memory:decisions.md', 'supersede_decision', args)))

// Architecture diagram ──────────────────────────────────────────────────────
// All ops route through the typed-op layer and re-render Mermaid from the
// structured nodes/edges/layers — never raw Mermaid string editing.

server.registerTool('delma_arch_set_prose', {
  title: 'Architecture: Set "How it works" Prose',
  description: 'Replace the plain-English "How it works" section above the diagram.',
  inputSchema: { text: z.string() }
}, withLogging('delma_arch_set_prose', (args) => runOp('diagram:architecture', 'set_prose', args)))

server.registerTool('delma_arch_add_node', {
  title: 'Architecture: Add Node',
  description: 'Add a node to the architecture diagram.',
  inputSchema: {
    id: z.string().describe('Short identifier, e.g. "Auto" or "WelcomeJourney"'),
    label: z.string().describe('Display label, may include <br/> for multiline'),
    kind: z.enum(['de', 'deSource', 'sql', 'automation', 'journey', 'email', 'cloudpage', 'decision', 'endpoint']),
    note: z.string().optional().describe('Floating italic annotation, 2-5 words'),
    layer: z.string().optional().describe('Layer id this node belongs to')
  }
}, withLogging('delma_arch_add_node', (args) => runOp('diagram:architecture', 'add_node', args)))

server.registerTool('delma_arch_set_node_label', {
  title: 'Architecture: Set Node Label',
  description: 'Change the display label of a node.',
  inputSchema: { id: z.string(), label: z.string() }
}, withLogging('delma_arch_set_node_label', (args) => runOp('diagram:architecture', 'set_node_label', args)))

server.registerTool('delma_arch_set_node_note', {
  title: 'Architecture: Set Node Note',
  description: 'Change the floating italic annotation next to a node. Pass empty string to remove.',
  inputSchema: { id: z.string(), note: z.string() }
}, withLogging('delma_arch_set_node_note', (args) => runOp('diagram:architecture', 'set_node_note', args)))

server.registerTool('delma_arch_set_node_kind', {
  title: 'Architecture: Set Node Kind',
  description: 'Reclassify a node (changes its shape and color).',
  inputSchema: { id: z.string(), kind: z.enum(['de', 'deSource', 'sql', 'automation', 'journey', 'email', 'cloudpage', 'decision', 'endpoint']) }
}, withLogging('delma_arch_set_node_kind', (args) => runOp('diagram:architecture', 'set_node_kind', args)))

server.registerTool('delma_arch_move_node', {
  title: 'Architecture: Move Node to Layer',
  description: 'Move a node into a different layer (or pass empty string to remove from any layer).',
  inputSchema: { id: z.string(), layer: z.string() }
}, withLogging('delma_arch_move_node', (args) => runOp('diagram:architecture', 'move_node_to_layer', args)))

server.registerTool('delma_arch_remove_node', {
  title: 'Architecture: Remove Node',
  description: 'Remove a node and any edges touching it.',
  inputSchema: { id: z.string() }
}, withLogging('delma_arch_remove_node', (args) => runOp('diagram:architecture', 'remove_node', args)))

server.registerTool('delma_arch_add_edge', {
  title: 'Architecture: Add Edge',
  description: 'Connect two nodes with a directed arrow.',
  inputSchema: { from: z.string(), to: z.string(), label: z.string().optional() }
}, withLogging('delma_arch_add_edge', (args) => runOp('diagram:architecture', 'add_edge', args)))

server.registerTool('delma_arch_remove_edge', {
  title: 'Architecture: Remove Edge',
  description: 'Remove the edge between two nodes.',
  inputSchema: { from: z.string(), to: z.string() }
}, withLogging('delma_arch_remove_edge', (args) => runOp('diagram:architecture', 'remove_edge', args)))

server.registerTool('delma_arch_add_layer', {
  title: 'Architecture: Add Layer',
  description: 'Add a layer subgraph for grouping related nodes.',
  inputSchema: { id: z.string(), title: z.string() }
}, withLogging('delma_arch_add_layer', (args) => runOp('diagram:architecture', 'add_layer', args)))

server.registerTool('delma_arch_remove_layer', {
  title: 'Architecture: Remove Layer',
  description: 'Remove a layer (its nodes are promoted to no-layer).',
  inputSchema: { id: z.string() }
}, withLogging('delma_arch_remove_layer', (args) => runOp('diagram:architecture', 'remove_layer', args)))

// My Notes ──────────────────────────────────────────────────────────────────

server.registerTool('delma_append_my_note', {
  title: 'Append My Note',
  description: 'Add a private note to the current user\'s scratchpad. Private — only you see it.',
  inputSchema: { text: z.string() }
}, withLogging('delma_append_my_note', (args) => runOp('memory:my-notes.md', 'append_my_note', args)))

// ── Conversation Sync ───────────────────────────────────────────────────────

server.registerTool(
  'sync_conversation_summary',
  {
    title: 'Sync Conversation Summary (LEGACY)',
    description: `LEGACY bulk-sync tool. STRONGLY PREFER the typed-op tools instead:
- delma_add_person / delma_set_role / delma_add_reporting_line for People
- delma_add_playbook_rule for Playbook
- delma_set_environment_key for Environment IDs
- delma_add_decision / delma_add_action for Decisions & Actions
- delma_append_my_note for personal notes
- save_diagram_view for Architecture diagram updates

The typed-op tools are deterministic, surgical, and can't corrupt content.
Only fall back to this tool when the typed ops genuinely don't fit (bulk
import, free-form prose that spans multiple tabs).`,
    inputSchema: {
      summary: z.string().describe('Plain-English summary of facts, decisions, people, or details discussed in the conversation. Be specific — include names, IDs, roles, system details.')
    }
  },
  withLogging('sync_conversation_summary', async ({ summary }) => {
    const { projectId, userId } = requireContext()
    console.log('[mcp sync] summary:', summary.substring(0, 100), '...')

    // Read current workspace state
    const [views, memory] = await Promise.all([
      readDiagramViews(projectId, userId),
      readMemoryMap(projectId, userId)
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
    const ws = await getWorkspace(projectId)
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
        await sb.from('memory_notes').update({ content }).eq('project_id', projectId).eq('filename', tab.filename)
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
    const { projectId, userId } = requireContext()
    const view = await getDiagramView(projectId, viewKey, userId)
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
