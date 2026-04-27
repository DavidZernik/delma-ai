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
import { cleanMermaid } from './lib/clean-mermaid.js'
import { loadSfmcAccounts } from './lib/local-config.js'
import * as sfmcClient from './lib/sfmc-client.js'

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
  'delma_set_environment_key',
  'delma_arch_add_node', 'delma_arch_move_node', 'delma_arch_remove_node',
  'delma_arch_set_node_kind', 'delma_arch_set_node_label', 'delma_arch_set_node_note', 'delma_arch_set_node_description',
  'delma_arch_add_edge', 'delma_arch_remove_edge',
  'delma_arch_add_layer', 'delma_arch_remove_layer', 'delma_arch_set_prose',
  'sync_conversation_summary', 'save_diagram_view',
  'delma_sfmc_create_de', 'delma_sfmc_insert_rows',
  'delma_sfmc_create_query_activity', 'delma_sfmc_run_query',
  'delma_sfmc_create_automation', 'delma_sfmc_run_automation'
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
    description: 'LEGACY free-form append. Prefer typed ops: mcp__delma__delma_add_decision / mcp__delma__delma_add_action for decisions.md, mcp__delma__delma_set_environment_key for environment.md. Use this only when the typed ops do not fit (e.g. unstructured prose).',
    inputSchema: {
      file: z.enum(['environment.md', 'decisions.md']),
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
  description: `Add a business process rule, unwritten norm, or timing gotcha to the org-wide Playbook (General Patterns and Docs tab).

Write ONE focused rule per call — a single operational principle, not a bundle. If the user shares knowledge that decomposes into several distinct rules, call this tool once per rule.

**Before calling**, skim the "General Patterns and Docs" section already in your prompt: if the candidate rule is a restatement of an existing one, skip the add (or call \`supersede_rule\` if it genuinely replaces one). Related-but-distinct rules in the same domain ARE welcome — don't conflate "how to do X safely" and "how to recover when X breaks" into one.`,
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
  description: `Set the short floating annotation that appears beside this node in the diagram itself — 2-5 words, e.g. "master source DE", "entry source", "email sequence".

For the long-form explanation shown in the click-to-reveal modal, use \`mcp__delma__delma_arch_set_node_description\` instead.

Pass empty string for \`note\` to remove.`,
  inputSchema: { id: z.string(), note: z.string() }
}, withLogging('delma_arch_set_node_note', (args) => runOp('diagram:architecture', 'set_node_note', args)))

server.registerTool('delma_arch_set_node_description', {
  title: 'Architecture: Set Node Description',
  description: `Set the long-form explanation users see when they click this node in the Project Details diagram.

Write at least 2 concise, layman-English sentences: what this step is, how it works, and the specific SFMC assets involved. Audience is non-technical marketing ops.

**Always use full SFMC paths with \`>\` separators, never bare asset names.** Examples:
- \`Content Builder > Journeys > Brand > brand_all_hbd_2026-final\`
- \`Automation Studio > Birthday_Daily_Send_Refresh\`
- \`Data Extensions > Shared > ENT.All_Patients_Opted_In\`
- \`Journey Builder > Birthday Daily Email Journey v2\`

If you don't know the path, fetch it from SFMC first (asset \`category.name\` for Content Builder assets, category tree for DEs, etc.) before writing the description.

Pass empty string for \`description\` to remove.`,
  inputSchema: { id: z.string(), description: z.string() }
}, withLogging('delma_arch_set_node_description', (args) => runOp('diagram:architecture', 'set_node_description', args)))

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

// ── Conversation Sync ───────────────────────────────────────────────────────

server.registerTool(
  'sync_conversation_summary',
  {
    title: 'Sync Conversation Summary (LEGACY)',
    description: `LEGACY bulk-sync tool. STRONGLY PREFER the typed-op tools instead:
- mcp__delma__delma_add_person / mcp__delma__delma_set_role / mcp__delma__delma_add_reporting_line for People
- mcp__delma__delma_add_playbook_rule for Playbook
- mcp__delma__delma_set_environment_key for Environment IDs
- mcp__delma__delma_add_decision / mcp__delma__delma_add_action for Decisions & Actions
- mcp__delma__save_diagram_view for Architecture diagram updates

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
        await sb.from('diagram_views').update({ mermaid: cleanMermaid(content) }).eq('id', tab.id)
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

// ── SFMC tools ───────────────────────────────────────────────────────────────
// Thin adapters over server/lib/sfmc-client.js. Claude calls these with plain
// JSON — Delma builds the SOAP envelope / REST payload and speaks to SFMC.
// The agent never hand-rolls XML. All tools take optional `bu: 'child' | 'parent'`
// (default: child) and resolve the account from the active project's org.

async function resolveSfmcAccount(bu = 'child') {
  // Creds live in ~/.config/sfmc/.env — one set of BUs per Delma install,
  // shared across every project. No org-scoped lookup needed.
  const accounts = loadSfmcAccounts()
  const acct = accounts[bu] || accounts.child || accounts.parent
  if (!acct) throw new Error(`no SFMC credentials configured (asked for "${bu}" BU). Populate ~/.config/sfmc/.env.`)
  return acct
}

const BU_FIELD = z.enum(['child', 'parent']).optional().describe('BU to target (default: child).')

server.registerTool('delma_sfmc_create_de', {
  title: 'SFMC: Create Data Extension',
  description: `Create a Data Extension in SFMC. Delma handles OAuth + SOAP envelope — pass plain JSON only.

**Field types:** Text, Number, Date, Boolean, EmailAddress, Phone, Decimal, Locale.
**Text fields need \`length\`** (default behavior varies). **Decimal needs \`scale\`.**
**Primary key fields:** set \`isPrimaryKey: true\` and they'll also become non-nillable.
**Sendable DEs:** set \`sendable: true\` and name the subscriber-key field in \`sendableSubscriberField\` (defaults to "SubscriberKey").
**Retention:** pass \`retentionDays\` (30 / 90 / 180 / 365 / etc.) — DE is deleted at end of retention. Omit for infinite retention.
**Folder:** pass \`folderId\` (CategoryID). Omit to drop at root.`,
  inputSchema: {
    name: z.string(),
    customerKey: z.string().optional().describe('External key. Defaults to name.'),
    description: z.string().optional(),
    fields: z.array(z.object({
      name: z.string(),
      customerKey: z.string().optional(),
      type: z.enum(['Text', 'Number', 'Date', 'Boolean', 'EmailAddress', 'Phone', 'Decimal', 'Locale']).optional(),
      length: z.number().int().positive().optional(),
      scale: z.number().int().nonnegative().optional(),
      isPrimaryKey: z.boolean().optional(),
      isRequired: z.boolean().optional(),
      isNillable: z.boolean().optional(),
      defaultValue: z.string().optional()
    })),
    sendable: z.boolean().optional(),
    sendableSubscriberField: z.string().optional(),
    retentionDays: z.number().int().positive().optional(),
    folderId: z.number().int().optional(),
    bu: BU_FIELD
  }
}, withLogging('delma_sfmc_create_de', async (args) => {
  const acct = await resolveSfmcAccount(args.bu)
  const result = await sfmcClient.createDataExtension(acct, args)
  return text(result)
}))

server.registerTool('delma_sfmc_list_des', {
  title: 'SFMC: List Data Extensions',
  description: `List Data Extensions matching a name pattern (SQL LIKE syntax: % = wildcard) or within a folder. Returns up to \`limit\` items (default 50). Use this BEFORE creating a DE to check if one already exists with the same name/key.`,
  inputSchema: {
    namePattern: z.string().optional().describe('SQL LIKE pattern, e.g. "Engagement_%"'),
    folderId: z.number().int().optional(),
    limit: z.number().int().positive().optional(),
    bu: BU_FIELD
  }
}, withLogging('delma_sfmc_list_des', async (args) => {
  const acct = await resolveSfmcAccount(args.bu)
  const result = await sfmcClient.listDataExtensions(acct, args)
  return text(result)
}))

server.registerTool('delma_sfmc_get_de', {
  title: 'SFMC: Get Data Extension',
  description: `Fetch full metadata for a Data Extension including its field list. Use to check a DE's schema before referencing it in a query activity or inserting rows.`,
  inputSchema: {
    customerKey: z.string(),
    bu: BU_FIELD
  }
}, withLogging('delma_sfmc_get_de', async (args) => {
  const acct = await resolveSfmcAccount(args.bu)
  const result = await sfmcClient.getDataExtension(acct, args)
  return text(result)
}))

server.registerTool('delma_sfmc_insert_rows', {
  title: 'SFMC: Insert Rows',
  description: `Upsert rows into a Data Extension (dedupes on the DE's primary keys).

**Row shape:** each row is \`{ keys: { PK_FIELD: value, ... }, values: { OTHER_FIELD: value, ... } }\`. \`keys\` must contain every primary-key column; \`values\` contains the rest. Do NOT send flat objects.

Example for a DE with PK \`SubscriberKey\`:
\`\`\`
rows: [
  { keys: { SubscriberKey: "abc" }, values: { EmailAddress: "a@b.com", LastEngagementDate: "2026-04-01" } }
]
\`\`\``,
  inputSchema: {
    customerKey: z.string(),
    rows: z.array(z.object({
      keys: z.record(z.string(), z.any()),
      values: z.record(z.string(), z.any()).optional()
    })),
    bu: BU_FIELD
  }
}, withLogging('delma_sfmc_insert_rows', async (args) => {
  const acct = await resolveSfmcAccount(args.bu)
  const result = await sfmcClient.insertRows(acct, args)
  return text(result)
}))

server.registerTool('delma_sfmc_create_query_activity', {
  title: 'SFMC: Create Query Activity',
  description: `Create a SQL Query Activity that writes the result set into a target DE. Used inside automations. updateType: Overwrite (replace all rows), Append (insert only), UpdateAdd (upsert), UpdateOnly (update matched rows).

Target DE must exist already (use delma_sfmc_create_de first). Reference DEs in FROM by their CustomerKey / Name.`,
  inputSchema: {
    name: z.string(),
    key: z.string().optional(),
    description: z.string().optional(),
    targetDE: z.string().describe('CustomerKey of the target DE'),
    sql: z.string().describe('SFMC SQL — T-SQL dialect, subset'),
    updateType: z.enum(['Overwrite', 'Append', 'UpdateAdd', 'UpdateOnly']).optional(),
    bu: BU_FIELD
  }
}, withLogging('delma_sfmc_create_query_activity', async (args) => {
  const acct = await resolveSfmcAccount(args.bu)
  const result = await sfmcClient.createQueryActivity(acct, args)
  return text(result)
}))

server.registerTool('delma_sfmc_run_query', {
  title: 'SFMC: Run Query Activity',
  description: `Kick off a Query Activity immediately (outside of an automation). Useful for one-off data fixes or testing. Returns when the run starts; doesn't wait for completion.`,
  inputSchema: {
    queryId: z.string(),
    bu: BU_FIELD
  }
}, withLogging('delma_sfmc_run_query', async (args) => {
  const acct = await resolveSfmcAccount(args.bu)
  const result = await sfmcClient.runQueryActivity(acct, args)
  return text(result)
}))

server.registerTool('delma_sfmc_create_automation', {
  title: 'SFMC: Create Automation',
  description: `Create an Automation Studio automation from an array of steps. Each step contains activities to run in parallel; steps run sequentially.

**Activity types (activityObjectId = the key of the activity to run, objectTypeId identifies the type):**
- Query Activity: objectTypeId = 300
- Import File Activity: objectTypeId = 73
- Data Extract: objectTypeId = 73
- Email Send: objectTypeId = 42

**Schedule (optional):** pass \`{ startDate, icalRecur, timezoneId? }\` to run on a recurring schedule. icalRecur follows RFC 5545 (e.g. "FREQ=DAILY;INTERVAL=1"). timezoneId defaults to 10 (Eastern). Omit \`schedule\` for an unscheduled automation (run manually or via delma_sfmc_run_automation).`,
  inputSchema: {
    name: z.string(),
    key: z.string().optional(),
    description: z.string().optional(),
    steps: z.array(z.object({
      stepNumber: z.number().int().optional(),
      name: z.string().optional(),
      activities: z.array(z.object({
        name: z.string(),
        activityObjectId: z.string(),
        objectTypeId: z.number().int().optional(),
        displayOrder: z.number().int().optional()
      }))
    })),
    schedule: z.object({
      startDate: z.string(),
      icalRecur: z.string(),
      timezoneId: z.number().int().optional(),
      endDate: z.string().optional()
    }).optional(),
    bu: BU_FIELD
  }
}, withLogging('delma_sfmc_create_automation', async (args) => {
  const acct = await resolveSfmcAccount(args.bu)
  const result = await sfmcClient.createAutomation(acct, args)
  return text(result)
}))

server.registerTool('delma_sfmc_run_automation', {
  title: 'SFMC: Run Automation',
  description: `Start an automation immediately (outside of its schedule). Useful for testing after creation or backfilling.`,
  inputSchema: {
    automationId: z.string(),
    bu: BU_FIELD
  }
}, withLogging('delma_sfmc_run_automation', async (args) => {
  const acct = await resolveSfmcAccount(args.bu)
  const result = await sfmcClient.runAutomation(acct, args)
  return text(result)
}))

server.registerTool('delma_sfmc_check_automation_status', {
  title: 'SFMC: Check Automation Status',
  description: `Poll an automation's current status, last run time, and next run time. Use after kicking one off with delma_sfmc_run_automation to monitor completion.`,
  inputSchema: {
    automationId: z.string(),
    bu: BU_FIELD
  }
}, withLogging('delma_sfmc_check_automation_status', async (args) => {
  const acct = await resolveSfmcAccount(args.bu)
  const result = await sfmcClient.getAutomationStatus(acct, args)
  return text(result)
}))

// ── Helper ───────────────────────────────────────────────────────────────────

function text(obj) {
  return { content: [{ type: 'text', text: JSON.stringify(obj, null, 2) }] }
}

// ── Start ────────────────────────────────────────────────────────────────────

const transport = new StdioServerTransport()
await server.connect(transport)
