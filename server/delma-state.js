import { join } from 'path'
import { mkdir, readdir, readFile, writeFile } from 'fs/promises'
import { existsSync } from 'fs'

export const MEMORY_FILES = [
  'environment.md',
  'logic.md',
  'people.md',
  'session-log.md'
]

export const DEFAULT_MEMORY_FILES = {
  'environment.md': '# Environment\n\nTech stack, dependencies, infrastructure, and repo setup.\n',
  'logic.md': '# Logic\n\nBusiness logic, architecture decisions, and implementation details.\n',
  'people.md': '# People\n\nOwnership, stakeholders, preferences, and tribal knowledge.\n',
  'session-log.md': '# Session Log\n'
}

export function defaultWorkspace(dir = '') {
  const projectName = dir ? dir.split('/').filter(Boolean).pop() : 'Workspace'
  return {
    projectName,
    updatedAt: new Date().toISOString(),
    views: [
      {
        id: 'architecture',
        title: 'Architecture',
        kind: 'architecture',
        description: 'How the systems, code assets, integrations, and automation surfaces work together.',
        summary: 'Use this to explain how the technical pieces fit together across SFMC, Salesforce CRM, integrations, and any supporting code.',
        mermaid: `---
config:
  look: neo
  theme: neo
  layout: elk
---
flowchart LR
  CRM["Salesforce CRM"] --> Sync["Integration Layer"]
  SFMC["SFMC"] --> Sync
  Sync --> Journeys["Journeys / Automations"]
  Sync --> Data["Data Extensions / Objects"]
  Code["Optional Local Code"] --> Sync
  Delma["Delma Memory"] --> Claude["Claude Code"]
  Claude --> Sync
`
      },
      {
        id: 'org',
        title: 'Org Chart',
        kind: 'people',
        description: 'The human org of the company: stakeholders, owners, decision-makers, and trust boundaries.',
        summary: 'Capture who owns what, who approves changes, who to ask, and where human context shapes the work.',
        mermaid: `---
config:
  look: neo
  theme: neo
  layout: elk
---
flowchart TD
  Architect["SFMC Architect"] --> PM["Product / PM"]
  Architect --> Marketing["Marketing Ops"]
  Architect --> SalesOps["Sales Ops / CRM"]
  PM --> Stakeholders["Stakeholders"]
  Marketing --> Approvals["Approvals / Signoff"]
  SalesOps --> Approvals
`
      }
    ]
  }
}

export function defaultGraph() {
  return {
    nodes: [],
    edges: [],
    updatedAt: new Date().toISOString()
  }
}

export function safeMemoryFile(filename) {
  const base = filename.replace(/[^a-zA-Z0-9._-]/g, '')
  if (!base || base.startsWith('.')) return null
  return base
}

export function getDelmaPath(dir) {
  return join(dir, '.delma')
}

export function getWorkspacePath(dir) {
  return join(getDelmaPath(dir), 'workspace.json')
}

export function getHistoryDir(dir) {
  return join(getDelmaPath(dir), 'history')
}

export function getGraphPath(dir) {
  return join(getDelmaPath(dir), 'graph.json')
}

export async function ensureProjectState(dir) {
  if (!dir) throw new Error('No project directory set')
  const delmaDir = getDelmaPath(dir)
  const historyDir = getHistoryDir(dir)

  if (!existsSync(delmaDir)) await mkdir(delmaDir, { recursive: true })
  if (!existsSync(historyDir)) await mkdir(historyDir, { recursive: true })

  for (const [file, content] of Object.entries(DEFAULT_MEMORY_FILES)) {
    const filePath = join(delmaDir, file)
    if (!existsSync(filePath)) await writeFile(filePath, content, 'utf-8')
  }

  const workspacePath = getWorkspacePath(dir)
  if (!existsSync(workspacePath)) {
    await writeFile(workspacePath, JSON.stringify(defaultWorkspace(dir), null, 2), 'utf-8')
  }

  const graphPath = getGraphPath(dir)
  if (!existsSync(graphPath)) {
    await writeFile(graphPath, JSON.stringify(defaultGraph(), null, 2), 'utf-8')
  }

  return { delmaDir, historyDir, workspacePath, graphPath }
}

export async function readWorkspace(dir) {
  await ensureProjectState(dir)
  return JSON.parse(await readFile(getWorkspacePath(dir), 'utf-8'))
}

export async function readGraph(dir) {
  await ensureProjectState(dir)
  return JSON.parse(await readFile(getGraphPath(dir), 'utf-8'))
}

export async function readMemoryMap(dir) {
  await ensureProjectState(dir)
  const entries = await Promise.all(
    MEMORY_FILES.map(async (file) => {
      const filePath = join(getDelmaPath(dir), file)
      const content = existsSync(filePath) ? await readFile(filePath, 'utf-8') : ''
      return [file, content]
    })
  )
  return Object.fromEntries(entries)
}

export async function listHistory(dir) {
  await ensureProjectState(dir)
  return (await readdir(getHistoryDir(dir))).filter((name) => name.endsWith('.json')).sort().reverse()
}

export async function writeHistorySnapshot(dir, workspace, reason = 'workspace-save') {
  const stamp = new Date().toISOString().replace(/[:.]/g, '-')
  const file = `${stamp}--${reason}.json`
  const payload = {
    reason,
    snapshotAt: new Date().toISOString(),
    workspace
  }
  await writeFile(join(getHistoryDir(dir), file), JSON.stringify(payload, null, 2), 'utf-8')
  return file
}

export function buildClaudeFromWorkspace(workspace, memoryMap) {
  const sections = [
    '# Delma Workspace Memory',
    '',
    '> Generated by Delma. Edit the workspace in Delma, not this file.',
    ''
  ]

  sections.push('## Diagram Views', '')
  for (const view of workspace.views || []) {
    sections.push(`### ${view.title}`)
    if (view.description) sections.push(view.description)
    if (view.summary) sections.push('', view.summary)
    sections.push('', '```mermaid', view.mermaid?.trim() || 'flowchart TD\n  A[Empty]', '```', '')
  }

  const memoryEntries = Object.entries(memoryMap).filter(([, value]) => value && value.trim())
  if (memoryEntries.length) {
    sections.push('## Reference Notes', '')
    for (const [file, content] of memoryEntries) {
      sections.push(`### ${file}`, '', content.trim(), '')
    }
  }

  return sections.join('\n').trim() + '\n'
}

export async function composeClaudeMd(dir) {
  await ensureProjectState(dir)
  const [workspace, memoryMap] = await Promise.all([readWorkspace(dir), readMemoryMap(dir)])
  const composed = buildClaudeFromWorkspace(workspace, memoryMap)

  await writeFile(join(getDelmaPath(dir), 'CLAUDE.md'), composed, 'utf-8')
  await writeFile(join(dir, 'CLAUDE.md'), composed, 'utf-8')

  return composed
}

export async function writeWorkspace(dir, workspace, reason = 'workspace-save') {
  await ensureProjectState(dir)
  const next = {
    ...workspace,
    updatedAt: new Date().toISOString()
  }
  await writeFile(getWorkspacePath(dir), JSON.stringify(next, null, 2), 'utf-8')
  const snapshotFile = await writeHistorySnapshot(dir, next, reason)
  await composeClaudeMd(dir)
  return { workspace: next, snapshotFile }
}
