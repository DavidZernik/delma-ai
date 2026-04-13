// Delma MCP Server — Supabase backend
// Runs via stdio transport. Claude Code connects to this.
// Env: DELMA_WORKSPACE_ID, DELMA_USER_ID (set in .mcp.json)

import { config } from 'dotenv'
config()

import { z } from 'zod'
import { McpServer, ResourceTemplate } from '@modelcontextprotocol/sdk/server/mcp.js'
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
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
  logMcpCall,
  composeClaudeMd
} from './delma-state.js'

const server = new McpServer({ name: 'delma', version: '2.0.0' })

let activeWorkspaceId = process.env.DELMA_WORKSPACE_ID || null
let activeUserId = process.env.DELMA_USER_ID || null

// ── Logging wrapper ──────────────────────────────────────────────────────────

function withLogging(toolName, handler) {
  return async (args) => {
    const start = Date.now()
    let caughtError = null
    try {
      return await handler(args)
    } catch (e) {
      caughtError = e
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
      return text({ ok: true, workspace: { id: ws.id, name: ws.name } })
    }

    if (name) {
      // Find by name
      const all = await listWorkspaces(activeUserId)
      const found = all.find(w => w.name.toLowerCase() === name.toLowerCase())
      if (found) {
        activeWorkspaceId = found.id
        return text({ ok: true, workspace: { id: found.id, name: found.name } })
      }
      // Create
      const ws = await createWorkspace(name, activeUserId)
      activeWorkspaceId = ws.id
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
    return text(views.map(({ view_key, title, kind, description, summary, visibility }) => ({
      view_key, title, kind, description, summary, visibility
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
    const updates = {}
    if (title !== undefined) updates.title = title
    if (description !== undefined) updates.description = description
    if (summary !== undefined) updates.summary = summary
    if (mermaid !== undefined) updates.mermaid = mermaid
    const view = await saveDiagramView(workspaceId, viewKey, updates, userId, reason)
    return text({ ok: true, view })
  })
)

server.registerTool(
  'append_memory_note',
  {
    title: 'Append Memory Note',
    description: 'Append text to a memory file (environment.md, logic.md, people.md, session-log.md).',
    inputSchema: {
      file: z.enum(['environment.md', 'logic.md', 'people.md', 'session-log.md']),
      note: z.string(),
      heading: z.string().optional()
    }
  },
  withLogging('append_memory_note', async ({ file, note, heading }) => {
    const { workspaceId, userId } = requireContext()
    await appendMemoryNote(workspaceId, file, note, heading, userId)
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
