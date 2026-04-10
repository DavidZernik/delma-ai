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
        id: 'workspace',
        title: 'Workspace',
        kind: 'architecture',
        description: 'Shared map of the client, org context, systems, and current operational surface area.',
        summary: 'This is the top-level Delma map for SFMC, Salesforce CRM, stakeholder context, and any optional local assets.',
        mermaid: `---
config:
  look: neo
  theme: neo
  layout: elk
---
flowchart LR
  PM["PM / Stakeholder"] --> Delma["Delma Workspace"]
  Architect["SFMC Architect"] --> Delma
  Claude["Claude Code"] --> Delma
  Delma --> SFMC["SFMC"]
  Delma --> CRM["Salesforce CRM"]
  Delma --> Memory["Memory + Diagrams + CLAUDE.md"]
`
      },
      {
        id: 'connections',
        title: 'Connections',
        kind: 'infrastructure',
        description: 'Credentials, API surfaces, business units, and environment context.',
        summary: 'Keep the operational keys in one visible place so Delma can safely connect to SFMC and Salesforce when needed.',
        mermaid: `---
config:
  look: neo
  theme: neo
  layout: elk
---
flowchart TD
  Workspace["Delma Workspace"] --> SFMCCreds["SFMC Credentials"]
  Workspace --> CRMCreds["Salesforce CRM Credentials"]
  Workspace --> APIs["API Keys / Secrets"]
  SFMCCreds --> BU["Business Units / MIDs"]
  CRMCreds --> Sandbox["Sandbox / Prod Orgs"]
  APIs --> Health["Connection Status / Last Test"]
`
      },
      {
        id: 'org',
        title: 'Org',
        kind: 'people',
        description: 'People, ownership, stakeholders, and trust boundaries.',
        summary: 'Capture who owns what, which business stakeholders matter, and where decisions come from.',
        mermaid: `---
config:
  look: neo
  theme: neo
  layout: elk
---
flowchart TD
  You["You"] --> Claude["Claude Code"]
  Claude --> Delma["Delma"]
  Delma --> Memory["Project Memory"]
  Memory --> Owners["Owners & Stakeholders"]
  Memory --> Constraints["Known Constraints"]
  Owners --> Decisions["Decision Context"]
`
      },
      {
        id: 'data-flows',
        title: 'Data Flows',
        kind: 'data',
        description: 'How information moves through SFMC, Salesforce CRM, and any connected systems.',
        summary: 'Use this for journeys, data extensions, CRM objects, APIs, and any operational flow you need to reason about quickly.',
        mermaid: `---
config:
  look: neo
  theme: neo
  layout: elk
---
flowchart LR
  Source["External Source"] --> Ingest["Ingest / API"]
  Ingest --> SFMC["SFMC"]
  SFMC --> Journey["Journey / Automation"]
  Journey --> Output["Customer Output"]
  SFMC --> Reporting["Reporting / Audit"]
`
      },
      {
        id: 'automations',
        title: 'Automations',
        kind: 'operations',
        description: 'Scheduled jobs, triggers, and operational dependencies.',
        summary: 'Track what runs, what it depends on, and where failure or manual intervention can happen.',
        mermaid: `---
config:
  look: neo
  theme: neo
  layout: elk
---
flowchart TD
  Trigger["Trigger"] --> Job["Automation"]
  Job --> Script["Script / Query"]
  Script --> Data["Data Extension"]
  Data --> Journey["Journey Update"]
  Job --> Alert["Alert / Review"]
`
      },
      {
        id: 'current-work',
        title: 'Current Work',
        kind: 'focus',
        description: 'A focused working map for the task in front of you right now.',
        summary: 'Keep this intentionally small. It should answer what matters in the current change, whether that change lives in SFMC, CRM, or local assets.',
        mermaid: `---
config:
  look: neo
  theme: neo
  layout: elk
---
flowchart LR
  Task["Current Task"] --> Files["Files / Assets"]
  Task --> Systems["Systems Touched"]
  Task --> Risks["Open Risks"]
  Files --> Outcome["Planned Outcome"]
  Systems --> Outcome
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
