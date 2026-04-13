// Delma state management — Supabase backend
// All workspace, diagram, memory, and history operations go through Supabase.

import { supabase } from './lib/supabase.js'

export const MEMORY_FILES = [
  'environment.md',
  'logic.md',
  'people.md',
  'session-log.md'
]

const VISIBILITY_RULES = {
  'environment.md': 'shared',
  'logic.md': 'shared',
  'people.md': 'shared',
  'session-log.md': 'private'
}

const DEFAULT_MEMORY_CONTENT = {
  'environment.md': '# Environment\n\nTech stack, dependencies, infrastructure, and repo setup.\n',
  'logic.md': '# Logic\n\nBusiness logic, architecture decisions, and implementation details.\n',
  'people.md': '# People\n\nOwnership, stakeholders, preferences, and tribal knowledge.\n',
  'session-log.md': '# Session Log\n'
}

const DEFAULT_VIEWS = [
  {
    view_key: 'architecture',
    title: 'Architecture',
    kind: 'architecture',
    description: 'How the systems, code assets, integrations, and automation surfaces work together.',
    summary: 'Use this to explain how the technical pieces fit together.',
    visibility: 'shared',
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
    view_key: 'org',
    title: 'Org Chart',
    kind: 'people',
    description: 'The human org of the company: stakeholders, owners, decision-makers, and trust boundaries.',
    summary: 'Capture who owns what, who approves changes, and where human context shapes the work.',
    visibility: 'shared',
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

// ── Workspaces ───────────────────────────────────────────────────────────────

export async function createWorkspace(name, userId) {
  const { data: workspace, error } = await supabase
    .from('workspaces')
    .insert({ name, created_by: userId })
    .select()
    .single()
  if (error) throw new Error(`Failed to create workspace: ${error.message}`)

  // Add creator as owner
  await supabase.from('workspace_members').insert({
    workspace_id: workspace.id,
    user_id: userId,
    role: 'owner'
  })

  // Seed default diagram views
  for (const view of DEFAULT_VIEWS) {
    await supabase.from('diagram_views').insert({
      workspace_id: workspace.id,
      owner_id: userId,
      ...view
    })
  }

  // Seed default memory notes
  for (const [filename, content] of Object.entries(DEFAULT_MEMORY_CONTENT)) {
    const visibility = VISIBILITY_RULES[filename] || 'shared'
    await supabase.from('memory_notes').insert({
      workspace_id: workspace.id,
      filename,
      content,
      visibility,
      owner_id: userId
    })
  }

  return workspace
}

export async function listWorkspaces(userId) {
  const { data, error } = await supabase
    .from('workspace_members')
    .select('workspace_id, role, workspaces(id, name, created_at)')
    .eq('user_id', userId)
  if (error) throw new Error(`Failed to list workspaces: ${error.message}`)
  return data.map(row => ({ ...row.workspaces, role: row.role }))
}

export async function getWorkspace(workspaceId) {
  const { data, error } = await supabase
    .from('workspaces')
    .select('*')
    .eq('id', workspaceId)
    .single()
  if (error) throw new Error(`Workspace not found: ${error.message}`)
  return data
}

// ── Diagram Views ────────────────────────────────────────────────────────────

export async function readDiagramViews(workspaceId, userId) {
  const { data, error } = await supabase
    .from('diagram_views')
    .select('*')
    .eq('workspace_id', workspaceId)
    .or(`visibility.eq.shared,owner_id.eq.${userId}`)
    .order('view_key')
  if (error) throw new Error(`Failed to read views: ${error.message}`)
  return data
}

export async function getDiagramView(workspaceId, viewKey, userId) {
  const { data, error } = await supabase
    .from('diagram_views')
    .select('*')
    .eq('workspace_id', workspaceId)
    .eq('view_key', viewKey)
    .or(`visibility.eq.shared,owner_id.eq.${userId}`)
    .single()
  if (error) throw new Error(`View not found: ${error.message}`)
  return data
}

export async function saveDiagramView(workspaceId, viewKey, updates, userId, reason) {
  // Find existing view
  const { data: existing } = await supabase
    .from('diagram_views')
    .select('id')
    .eq('workspace_id', workspaceId)
    .eq('view_key', viewKey)
    .or(`visibility.eq.shared,owner_id.eq.${userId}`)
    .single()

  const payload = {
    workspace_id: workspaceId,
    view_key: viewKey,
    owner_id: userId,
    ...updates
  }

  let view
  if (existing) {
    const { data, error } = await supabase
      .from('diagram_views')
      .update(payload)
      .eq('id', existing.id)
      .select()
      .single()
    if (error) throw new Error(`Failed to update view: ${error.message}`)
    view = data
  } else {
    const { data, error } = await supabase
      .from('diagram_views')
      .insert(payload)
      .select()
      .single()
    if (error) throw new Error(`Failed to create view: ${error.message}`)
    view = data
  }

  // Write history snapshot
  await writeHistorySnapshot(workspaceId, userId, reason || `save-${viewKey}`)

  return view
}

// ── Memory Notes ─────────────────────────────────────────────────────────────

export async function readMemoryMap(workspaceId, userId) {
  const { data, error } = await supabase
    .from('memory_notes')
    .select('*')
    .eq('workspace_id', workspaceId)
    .or(`visibility.eq.shared,owner_id.eq.${userId}`)
  if (error) throw new Error(`Failed to read memory: ${error.message}`)

  const map = {}
  for (const row of data) {
    map[row.filename] = row.content
  }
  return map
}

export async function appendMemoryNote(workspaceId, filename, note, heading, userId) {
  const visibility = VISIBILITY_RULES[filename] || 'shared'

  // Find existing note
  const { data: existing } = await supabase
    .from('memory_notes')
    .select('id, content')
    .eq('workspace_id', workspaceId)
    .eq('filename', filename)
    .or(`visibility.eq.shared,owner_id.eq.${userId}`)
    .single()

  const prefix = heading ? `\n## ${heading}\n` : '\n'
  const newContent = (existing?.content || '') + `${prefix}${note.trim()}\n`

  if (existing) {
    await supabase
      .from('memory_notes')
      .update({ content: newContent })
      .eq('id', existing.id)
  } else {
    await supabase
      .from('memory_notes')
      .insert({
        workspace_id: workspaceId,
        filename,
        content: newContent,
        visibility,
        owner_id: userId
      })
  }

  return newContent
}

export async function updateMemoryNote(workspaceId, filename, content, userId) {
  const visibility = VISIBILITY_RULES[filename] || 'shared'

  const { data: existing } = await supabase
    .from('memory_notes')
    .select('id')
    .eq('workspace_id', workspaceId)
    .eq('filename', filename)
    .or(`visibility.eq.shared,owner_id.eq.${userId}`)
    .single()

  if (existing) {
    await supabase
      .from('memory_notes')
      .update({ content })
      .eq('id', existing.id)
  } else {
    await supabase
      .from('memory_notes')
      .insert({ workspace_id: workspaceId, filename, content, visibility, owner_id: userId })
  }
}

// ── History ──────────────────────────────────────────────────────────────────

export async function writeHistorySnapshot(workspaceId, userId, reason) {
  // Capture current state as snapshot
  const views = await readDiagramViews(workspaceId, userId)
  const memory = await readMemoryMap(workspaceId, userId)

  await supabase.from('history_snapshots').insert({
    workspace_id: workspaceId,
    reason,
    snapshot: { views, memory },
    created_by: userId
  })
}

export async function listHistory(workspaceId) {
  const { data, error } = await supabase
    .from('history_snapshots')
    .select('id, reason, created_at, created_by')
    .eq('workspace_id', workspaceId)
    .order('created_at', { ascending: false })
    .limit(30)
  if (error) throw new Error(`Failed to list history: ${error.message}`)
  return data
}

// ── MCP Call Logging ─────────────────────────────────────────────────────────

export async function logMcpCall({ workspaceId, userId, tool, input, durationMs, success, error }) {
  try {
    await supabase.from('mcp_call_logs').insert({
      workspace_id: workspaceId || null,
      user_id: userId || null,
      tool,
      input,
      duration_ms: durationMs,
      success,
      error: error || null
    })
  } catch {
    // best-effort logging
  }
}

// ── CLAUDE.md Generation ─────────────────────────────────────────────────────

export function buildClaudeMd(views, memoryMap) {
  const sections = [
    '# Delma Workspace Memory',
    '',
    '> Generated by Delma. Edit the workspace in Delma, not this file.',
    '',
    '## Delma MCP — Auto-Update Instructions',
    '',
    'Call these tools automatically during the conversation — do not wait to be asked:',
    '',
    '- **`append_memory_note`** — when the user confirms a fact about a person, role, ownership, or decision',
    '- **`save_diagram_view`** — when a structural relationship changes (new person, new system, new connection, reporting change)',
    '- **`get_workspace_state`** — call at the start of each conversation to load current workspace context',
    '',
    'Rules:',
    '- Only write what the user has explicitly stated or confirmed. Never write inferences.',
    '- Batch updates: one call with all facts learned, not one call per fact.',
    '- Use `people.md` for who owns what, who reports to whom, who approves.',
    '- Use `logic.md` for business rules, routing decisions, architecture choices.',
    '- Use `environment.md` for IDs, keys, URLs, credentials context.',
    '- Use `session-log.md` for status, what was done this session, what remains.',
    '- Update the Org Chart diagram (`save_diagram_view` viewKey `org`) when reporting structure changes.',
    '',
    '## Diagram Views',
    ''
  ]

  for (const view of views || []) {
    sections.push(`### ${view.title}`)
    if (view.description) sections.push(view.description)
    if (view.summary) sections.push('', view.summary)
    sections.push('', '```mermaid', view.mermaid?.trim() || 'flowchart TD\n  A[Empty]', '```', '')
  }

  const memEntries = Object.entries(memoryMap || {}).filter(([, v]) => v?.trim())
  if (memEntries.length) {
    sections.push('## Reference Notes', '')
    for (const [file, content] of memEntries) {
      sections.push(`### ${file}`, '', content.trim(), '')
    }
  }

  return sections.join('\n').trim() + '\n'
}

export async function composeClaudeMd(workspaceId, userId) {
  const views = await readDiagramViews(workspaceId, userId)
  const memory = await readMemoryMap(workspaceId, userId)
  return buildClaudeMd(views, memory)
}
