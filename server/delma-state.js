// ──────────────────────────────────────────────────────────────────────────────
// Delma State Management — Supabase Backend
// ──────────────────────────────────────────────────────────────────────────────
//
// All workspace, diagram, memory, and history operations go through Supabase.
// Access control is enforced at two levels:
//
//   1. Row Level Security (RLS) in Postgres — enforces who can SELECT/UPDATE
//      based on workspace membership, role (owner/member), and permission level.
//      This is the hard security boundary. Even if the app has a bug, RLS prevents
//      unauthorized access.
//
//   2. Application-level permission checks — used by the UI to show/hide edit
//      buttons and by the MCP server to return helpful error messages. These are
//      a UX convenience on top of RLS, not a replacement.
//
// Permission levels (set per tab):
//   'private'      — only the owner can see and edit
//   'view-all'     — all workspace members can see, only owner/admin can edit
//   'edit-all'     — all workspace members can see and edit
//   'view-admins'  — only owners/admins can see and edit (hidden from members)
//
// ──────────────────────────────────────────────────────────────────────────────

import { supabase } from './lib/supabase.js'
import { cleanMermaid } from './lib/clean-mermaid.js'

// Project-level memory files. People and Playbook live in org_memory_notes.
export const MEMORY_FILES = [
  'environment.md',
  'decisions.md',
  'my-notes.md'
]

// Default permission for each memory file when creating a new workspace.
// These encode the product opinion about what should be visible to whom.
// Project-level memory tabs. People and Playbook are at the org level
// (org_memory_notes). my-notes is per-user private.
const DEFAULT_PERMISSIONS = {
  'environment.md': 'view-admins',
  'decisions.md': 'edit-all',       // anyone can capture a decision/action
  'my-notes.md': 'private'
}

const VISIBILITY_RULES = {
  'environment.md': 'shared',
  'decisions.md': 'shared',
  'my-notes.md': 'private'
}

const DEFAULT_MEMORY_CONTENT = {
  'environment.md': '# Environment\n\nSFMC Business Unit, MIDs, Data Extensions, Journeys, Automations, CloudPages, and other project-specific IDs and configuration.\n',
  'decisions.md': '# Decisions & Actions\n\n## Decisions\n- _What\'s been decided. Outline form, one bullet each._\n\n## Actions\n- _What needs to happen next. Outline form. Add owner if known._\n',
  'my-notes.md': '# My Notes\n\nPersonal scratchpad — only you see this. Jot down questions, reminders, half-baked thoughts.\n'
}

// ── Permission Helpers ──────────────────────────────────────────────────────

/**
 * Check if a user can edit a given item based on its permission level.
 * Used by the UI to show/hide edit buttons and by MCP to gate writes.
 *
 * @param {string} permission - The item's permission level
 * @param {string} ownerId - The item's owner UUID
 * @param {string} userId - The current user UUID
 * @param {string} role - The user's workspace role ('owner' or 'member')
 * @returns {boolean}
 */
export function canEdit(permission, ownerId, userId, role) {
  if (role === 'owner') return true  // owners can always edit
  switch (permission) {
    case 'edit-all': return true
    case 'private': return ownerId === userId
    case 'view-all': return false     // members can only view
    case 'view-admins': return false  // members can't even see this
    default: return false
  }
}

/**
 * Get the user's role in a workspace. Returns 'owner' or 'member'.
 */
export async function getUserRole(projectId, userId) {
  const { data, error } = await supabase
    .from('project_members')
    .select('role')
    .eq('project_id', projectId)
    .eq('user_id', userId)
    .single()
  if (error) console.error('[delma-state] getUserRole error:', error.message)
  return data?.role || 'member'
}

const DEFAULT_VIEWS = [
  {
    view_key: 'architecture',
    title: 'Project High Level',
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
  }
]

// ── Workspaces ───────────────────────────────────────────────────────────────

export async function createProject(name, userId) {
  const { data: workspace, error } = await supabase
    .from('projects')
    .insert({ name, created_by: userId })
    .select()
    .single()
  if (error) throw new Error(`Failed to create workspace: ${error.message}`)

  // Add creator as owner
  await supabase.from('project_members').insert({
    project_id: workspace.id,
    user_id: userId,
    role: 'owner'
  })

  // Seed default diagram views with permission levels
  for (const view of DEFAULT_VIEWS) {
    await supabase.from('diagram_views').insert({
      project_id: workspace.id,
      owner_id: userId,
      permission: 'view-all',  // everyone sees architecture, admins edit
      ...view
    })
  }

  // Seed default memory notes with per-file permission levels
  for (const [filename, content] of Object.entries(DEFAULT_MEMORY_CONTENT)) {
    const visibility = VISIBILITY_RULES[filename] || 'shared'
    const permission = DEFAULT_PERMISSIONS[filename] || 'edit-all'
    await supabase.from('memory_notes').insert({
      project_id: workspace.id,
      filename,
      content,
      visibility,
      permission,
      owner_id: userId
    })
  }

  return workspace
}

export async function listWorkspaces(userId) {
  const { data, error } = await supabase
    .from('project_members')
    .select('project_id, role, projects(id, name, created_at)')
    .eq('user_id', userId)
  if (error) throw new Error(`Failed to list projects: ${error.message}`)
  return data.map(row => ({ ...row.projects, role: row.role }))
}

export async function getWorkspace(projectId) {
  const { data, error } = await supabase
    .from('projects')
    .select('*')
    .eq('id', projectId)
    .single()
  if (error) throw new Error(`Workspace not found: ${error.message}`)
  return data
}

// ── Diagram Views ────────────────────────────────────────────────────────────

export async function readDiagramViews(projectId, userId) {
  const { data, error } = await supabase
    .from('diagram_views')
    .select('*')
    .eq('project_id', projectId)
    .or(`visibility.eq.shared,owner_id.eq.${userId}`)
    .order('view_key')
  if (error) throw new Error(`Failed to read views: ${error.message}`)
  return data
}

export async function getDiagramView(projectId, viewKey, userId) {
  const { data, error } = await supabase
    .from('diagram_views')
    .select('*')
    .eq('project_id', projectId)
    .eq('view_key', viewKey)
    .or(`visibility.eq.shared,owner_id.eq.${userId}`)
    .single()
  if (error) throw new Error(`View not found: ${error.message}`)
  return data
}

export async function saveDiagramView(projectId, viewKey, updates, userId, reason) {
  console.log('[delma-state] saveDiagramView:', viewKey, 'updates:', Object.keys(updates))
  if (typeof updates.mermaid === 'string') updates.mermaid = cleanMermaid(updates.mermaid)
  // Find existing view
  const { data: existing, error: findErr } = await supabase
    .from('diagram_views')
    .select('id')
    .eq('project_id', projectId)
    .eq('view_key', viewKey)
    .or(`visibility.eq.shared,owner_id.eq.${userId}`)
    .single()
  if (findErr && findErr.code !== 'PGRST116') console.error('[delma-state] saveDiagramView find error:', findErr.message)

  const payload = {
    project_id: projectId,
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
  await writeHistorySnapshot(projectId, userId, reason || `save-${viewKey}`)

  return view
}

// ── Memory Notes ─────────────────────────────────────────────────────────────

export async function readMemoryMap(projectId, userId) {
  const { data, error } = await supabase
    .from('memory_notes')
    .select('*')
    .eq('project_id', projectId)
    .or(`visibility.eq.shared,owner_id.eq.${userId}`)
  if (error) throw new Error(`Failed to read memory: ${error.message}`)

  const map = {}
  for (const row of data) {
    map[row.filename] = row.content
  }
  return map
}

export async function appendMemoryNote(projectId, filename, note, heading, userId) {
  console.log('[delma-state] appendMemoryNote:', filename, 'heading:', heading, 'noteLen:', note.length)
  const visibility = VISIBILITY_RULES[filename] || 'shared'

  // Find existing note
  const { data: existing } = await supabase
    .from('memory_notes')
    .select('id, content')
    .eq('project_id', projectId)
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
        project_id: projectId,
        filename,
        content: newContent,
        visibility,
        owner_id: userId
      })
  }

  return newContent
}

export async function updateMemoryNote(projectId, filename, content, userId) {
  const visibility = VISIBILITY_RULES[filename] || 'shared'

  const { data: existing } = await supabase
    .from('memory_notes')
    .select('id')
    .eq('project_id', projectId)
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
      .insert({ project_id: projectId, filename, content, visibility, owner_id: userId })
  }
}

// ── History ──────────────────────────────────────────────────────────────────

export async function writeHistorySnapshot(projectId, userId, reason) {
  // Capture current state as snapshot
  const views = await readDiagramViews(projectId, userId)
  const memory = await readMemoryMap(projectId, userId)

  await supabase.from('history_snapshots').insert({
    project_id: projectId,
    reason,
    snapshot: { views, memory },
    created_by: userId
  })
}

export async function listHistory(projectId) {
  const { data, error } = await supabase
    .from('history_snapshots')
    .select('id, reason, created_at, created_by')
    .eq('project_id', projectId)
    .order('created_at', { ascending: false })
    .limit(30)
  if (error) throw new Error(`Failed to list history: ${error.message}`)
  return data
}

// ── MCP Call Logging ─────────────────────────────────────────────────────────

export async function logMcpCall({ projectId, userId, tool, input, durationMs, success, error }) {
  try {
    await supabase.from('mcp_call_logs').insert({
      project_id: projectId || null,
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

// CLAUDE.md is now maintained manually as a static behavior file.
// composeClaudeMd returns the static content from the summarizer.
export async function composeClaudeMd(projectId, userId) {
  console.log('[delma-state] composeClaudeMd called, workspace:', projectId)
  const { readFile } = await import('fs/promises')
  const { resolve } = await import('path')
  try {
    const cwd = process.env.DELMA_PROJECT_DIR || process.cwd()
    return await readFile(resolve(cwd, 'CLAUDE.md'), 'utf-8')
  } catch {
    return '# Delma Workspace\n\nNo CLAUDE.md found.'
  }
}
