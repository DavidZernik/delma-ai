import { resolve } from 'path'
import { existsSync } from 'fs'
import { readFile, writeFile } from 'fs/promises'
import { z } from 'zod'
import { McpServer, ResourceTemplate } from '@modelcontextprotocol/sdk/server/mcp.js'
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import {
  ensureProjectState,
  readWorkspace,
  readGraph,
  readMemoryMap,
  listHistory,
  writeWorkspace,
  composeClaudeMd,
  getDelmaPath
} from './delma-state.js'

const server = new McpServer({
  name: 'delma',
  version: '1.0.0'
})

let activeProjectDir = process.env.DELMA_PROJECT_DIR ? resolve(process.env.DELMA_PROJECT_DIR) : null

async function requireProjectDir(projectDir) {
  const dir = resolve(projectDir || activeProjectDir || process.cwd())
  if (!existsSync(dir)) {
    throw new Error(`Project directory does not exist: ${dir}`)
  }
  activeProjectDir = dir
  await ensureProjectState(dir)
  return dir
}

async function loadState(dir) {
  const [workspace, graph, memory, history] = await Promise.all([
    readWorkspace(dir),
    readGraph(dir),
    readMemoryMap(dir),
    listHistory(dir)
  ])

  return {
    projectDir: dir,
    workspace,
    graph,
    memory,
    history
  }
}

server.registerTool(
  'open_project',
  {
    title: 'Open Delma Project',
    description: 'Set the active project directory for Delma and initialize .delma state there.',
    inputSchema: {
      projectDir: z.string().describe('Absolute or relative path to the project directory.')
    }
  },
  async ({ projectDir }) => {
    const dir = await requireProjectDir(projectDir)
    const state = await loadState(dir)
    return {
      content: [
        {
          type: 'text',
          text: JSON.stringify({
            ok: true,
            projectDir: dir,
            views: state.workspace.views.map(({ id, title }) => ({ id, title })),
            historyCount: state.history.length
          }, null, 2)
        }
      ]
    }
  }
)

server.registerTool(
  'get_delma_state',
  {
    title: 'Get Delma State',
    description: 'Read the current Delma workspace, memory files, graph, and snapshot history for the active project.',
    inputSchema: {
      projectDir: z.string().optional()
    }
  },
  async ({ projectDir }) => {
    const dir = await requireProjectDir(projectDir)
    const state = await loadState(dir)
    return {
      content: [
        {
          type: 'text',
          text: JSON.stringify(state, null, 2)
        }
      ]
    }
  }
)

server.registerTool(
  'list_diagram_views',
  {
    title: 'List Diagram Views',
    description: 'List the available Delma Mermaid views for the active project.',
    inputSchema: {
      projectDir: z.string().optional()
    }
  },
  async ({ projectDir }) => {
    const dir = await requireProjectDir(projectDir)
    const workspace = await readWorkspace(dir)
    return {
      content: [
        {
          type: 'text',
          text: JSON.stringify(
            workspace.views.map(({ id, title, kind, description, summary }) => ({
              id,
              title,
              kind,
              description,
              summary
            })),
            null,
            2
          )
        }
      ]
    }
  }
)

server.registerTool(
  'get_diagram_view',
  {
    title: 'Get Diagram View',
    description: 'Read one Delma Mermaid view by id.',
    inputSchema: {
      viewId: z.string(),
      projectDir: z.string().optional()
    }
  },
  async ({ viewId, projectDir }) => {
    const dir = await requireProjectDir(projectDir)
    const workspace = await readWorkspace(dir)
    const view = workspace.views.find((entry) => entry.id === viewId)
    if (!view) throw new Error(`Unknown view: ${viewId}`)
    return {
      content: [
        {
          type: 'text',
          text: JSON.stringify(view, null, 2)
        }
      ]
    }
  }
)

server.registerTool(
  'save_diagram_view',
  {
    title: 'Save Diagram View',
    description: 'Update one Delma Mermaid view, write a history snapshot, and recompose CLAUDE.md.',
    inputSchema: {
      viewId: z.string(),
      title: z.string().optional(),
      description: z.string().optional(),
      summary: z.string().optional(),
      mermaid: z.string().optional(),
      reason: z.string().optional(),
      projectDir: z.string().optional()
    }
  },
  async ({ viewId, title, description, summary, mermaid, reason, projectDir }) => {
    const dir = await requireProjectDir(projectDir)
    const workspace = await readWorkspace(dir)
    const view = workspace.views.find((entry) => entry.id === viewId)
    if (!view) throw new Error(`Unknown view: ${viewId}`)

    if (title !== undefined) view.title = title
    if (description !== undefined) view.description = description
    if (summary !== undefined) view.summary = summary
    if (mermaid !== undefined) view.mermaid = mermaid

    const result = await writeWorkspace(dir, workspace, reason || `mcp-save-${viewId}`)
    return {
      content: [
        {
          type: 'text',
          text: JSON.stringify(
            {
              ok: true,
              snapshotFile: result.snapshotFile,
              view
            },
            null,
            2
          )
        }
      ]
    }
  }
)

server.registerTool(
  'append_memory_note',
  {
    title: 'Append Memory Note',
    description: 'Append text to one Delma memory markdown file and recompose CLAUDE.md.',
    inputSchema: {
      file: z.enum(['environment.md', 'logic.md', 'people.md', 'session-log.md']),
      note: z.string(),
      heading: z.string().optional(),
      projectDir: z.string().optional()
    }
  },
  async ({ file, note, heading, projectDir }) => {
    const dir = await requireProjectDir(projectDir)
    const filePath = resolve(getDelmaPath(dir), file)
    const existing = existsSync(filePath) ? await readFile(filePath, 'utf-8') : ''
    const prefix = heading ? `\n## ${heading}\n` : '\n'
    await writeFile(filePath, `${existing}${prefix}${note.trim()}\n`, 'utf-8')
    const composed = await composeClaudeMd(dir)
    return {
      content: [
        {
          type: 'text',
          text: JSON.stringify({ ok: true, file, claudeLength: composed.length }, null, 2)
        }
      ]
    }
  }
)

server.registerTool(
  'compose_claude_md',
  {
    title: 'Compose CLAUDE.md',
    description: 'Regenerate CLAUDE.md for the active Delma project from workspace views and memory files.',
    inputSchema: {
      projectDir: z.string().optional()
    }
  },
  async ({ projectDir }) => {
    const dir = await requireProjectDir(projectDir)
    const composed = await composeClaudeMd(dir)
    return {
      content: [
        {
          type: 'text',
          text: JSON.stringify({ ok: true, projectDir: dir, length: composed.length }, null, 2)
        }
      ]
    }
  }
)

server.registerTool(
  'list_history',
  {
    title: 'List Delma History',
    description: 'List Delma workspace snapshot files for the active project.',
    inputSchema: {
      projectDir: z.string().optional()
    }
  },
  async ({ projectDir }) => {
    const dir = await requireProjectDir(projectDir)
    const history = await listHistory(dir)
    return {
      content: [
        {
          type: 'text',
          text: JSON.stringify(history, null, 2)
        }
      ]
    }
  }
)

server.registerResource(
  'workspace',
  new ResourceTemplate('delma://workspace/{viewId}', {
    list: undefined
  }),
  {
    title: 'Delma Diagram View',
    description: 'Read a Delma diagram view directly as a resource.'
  },
  async (uri, { viewId }) => {
    const dir = await requireProjectDir(activeProjectDir || process.cwd())
    const workspace = await readWorkspace(dir)
    const view = workspace.views.find((entry) => entry.id === viewId)
    if (!view) throw new Error(`Unknown view: ${viewId}`)
    return {
      contents: [
        {
          uri: uri.href,
          text: JSON.stringify(view, null, 2)
        }
      ]
    }
  }
)

const transport = new StdioServerTransport()
await server.connect(transport)
