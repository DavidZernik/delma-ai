// ──────────────────────────────────────────────────────────────────────────────
// Delma Frontend — Visual Workspace for Claude Code
// ──────────────────────────────────────────────────────────────────────────────
//
// This is the main UI for Delma. It renders:
//   - Diagram tabs (Architecture, etc.) using Mermaid inside markdown
//   - Document tabs (People, Campaign Logic, Environment, Session Log) as markdown
//   - All tabs support View/Edit modes with permission-based access control
//
// Data flow:
//   1. User signs in via Supabase Auth
//   2. Workspace loads from Supabase (views, memory, history, user role)
//   3. Supabase Realtime pushes changes from Claude Code MCP writes
//   4. User edits save directly to Supabase
//
// Permissions:
//   Each tab has a permission level (private, view-all, edit-all, view-admins).
//   The UI shows a lock icon on read-only tabs and hides the Edit button.
//   RLS policies in Postgres enforce the same rules at the database level.
//
// ──────────────────────────────────────────────────────────────────────────────

import mermaid from 'mermaid'
import elkLayouts from '@mermaid-js/layout-elk'
import { marked } from 'marked'
import { supabase } from './lib/supabase.js'

mermaid.registerLayoutLoaders(elkLayouts)
mermaid.initialize({
  startOnLoad: false,
  securityLevel: 'loose',
  theme: 'base',
  look: 'neo',
  layout: 'elk',
  flowchart: { curve: 'basis' }
})

const state = {
  user: null,
  userRole: 'member',   // 'owner' or 'member' — determines edit access
  org: null,             // { id, name, slug } — current organization
  orgs: [],              // all orgs user belongs to
  workspaceId: null,
  workspaceName: '',
  workspaces: [],
  views: [],             // diagram_views rows from Supabase (includes permission field)
  memoryRows: [],        // raw memory_notes rows (includes permission, owner_id)
  memory: {},            // { filename: content } for easy access
  orgMemoryRows: [],     // org-level memory notes (SFMC Setup, People)
  orgMemory: {},         // { filename: content } for org-level tabs
  history: [],
  activeViewKey: null,
  activeMemoryFile: null,
  previewMermaid: '',
  activeTopTab: 'diagram',
  diagramMode: 'view'
}

const els = {
  connectBtn: document.getElementById('connect-btn'),
  sdkStatus: document.getElementById('sdk-status'),
  activityRail: document.getElementById('activity-rail'),
  sdkBody: document.getElementById('sdk-body'),
  input: document.getElementById('input'),
  sendBtn: document.getElementById('send-btn'),
  logoutBtn: document.getElementById('logout-btn'),
  saveWorkspaceBtn: document.getElementById('save-workspace-btn'),
  saveViewBtn: document.getElementById('save-view-btn'),
  previewBtn: document.getElementById('preview-btn'),
  resetExampleBtn: document.getElementById('reset-example-btn'),
  viewTabs: document.getElementById('view-tabs'),
  historyList: document.getElementById('history-list'),
  memoryList: document.getElementById('memory-list'),
  viewTitle: document.getElementById('view-title'),
  viewDescription: document.getElementById('view-description'),
  viewSummary: document.getElementById('view-summary'),
  modeToggle: document.getElementById('mode-toggle'),
  viewModeBtn: document.getElementById('view-mode-btn'),
  editModeBtn: document.getElementById('edit-mode-btn'),
  workspaceStatus: document.getElementById('workspace-status'),
  projectPill: document.getElementById('project-pill'),
  historyPill: document.getElementById('history-pill'),
  diagramToolbarTitle: document.getElementById('diagram-toolbar-title'),
  diagramToolbarSubtitle: document.getElementById('diagram-toolbar-subtitle'),
  diagramOutput: document.getElementById('diagram-output'),
  diagramEditor: document.getElementById('diagram-editor'),
  viewTitleInput: document.getElementById('view-title-input'),
  viewDescriptionInput: document.getElementById('view-description-input'),
  viewSummaryInput: document.getElementById('view-summary-input'),
  viewMermaid: document.getElementById('view-mermaid'),
  saveNote: document.getElementById('save-note'),
  authOverlay: document.getElementById('auth-overlay'),
  authForm: document.getElementById('auth-form'),
  authUsername: document.getElementById('auth-username'),
  authPassword: document.getElementById('auth-password'),
  authError: document.getElementById('auth-error'),
  authCopy: document.getElementById('auth-copy'),
  projectDir: document.getElementById('project-dir')
}

// ── Helpers ──────────────────────────────────────────────────────────────────

function appendLog(title, body, tone = 'assistant') {
  const node = document.createElement('div')
  node.className = `message ${tone}`
  node.textContent = `${title}\n\n${body}`
  els.sdkBody.prepend(node)
}

function setActivity(text) { els.activityRail.textContent = text }
function setWorkspaceStatus(text) { els.workspaceStatus.textContent = text }

// ── Permission check (mirrors server/delma-state.js canEdit) ────────────────
// Used to show/hide edit buttons in the UI.
function canEditItem(item) {
  if (!item || !state.user) return false
  if (state.userRole === 'owner') return true
  switch (item.permission) {
    case 'edit-all': return true
    case 'private': return item.owner_id === state.user.id
    case 'view-all': return false
    case 'view-admins': return false
    default: return false
  }
}

function escapeHtml(text) {
  return String(text ?? '').replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;').replaceAll('"', '&quot;').replaceAll("'", '&#39;')
}

function trimPreview(text) {
  if (!text) return ''
  return text.length > 340 ? `${text.slice(0, 337)}...` : text
}

// ── Auth ─────────────────────────────────────────────────────────────────────

function setAuthUi(authenticated) {
  els.authOverlay.classList.toggle('visible', !authenticated)
  els.authOverlay.setAttribute('aria-hidden', String(authenticated))
  els.logoutBtn.classList.toggle('visible', authenticated)
}

async function checkAuth() {
  const { data: { user } } = await supabase.auth.getUser()
  state.user = user
  setAuthUi(!!user)
  return user
}

async function login(email, password) {
  const { data, error } = await supabase.auth.signInWithPassword({ email, password })
  if (error) throw new Error(error.message)
  state.user = data.user
  setAuthUi(true)
  return data.user
}

async function signup(email, password) {
  const { data, error } = await supabase.auth.signUp({ email, password })
  if (error) throw new Error(error.message)
  state.user = data.user
  setAuthUi(true)
  return data.user
}

async function logout() {
  await supabase.auth.signOut()
  state.user = null
  state.workspaceId = null
  state.views = []
  state.memory = {}
  state.history = []
  setAuthUi(false)
  renderWorkspace()
}

// ── Organization Loading ─────────────────────────────────────────────────────

async function loadOrgs() {
  if (!state.user) return
  const { data } = await supabase
    .from('org_members')
    .select('org_id, role, organizations(id, name, slug)')
    .eq('user_id', state.user.id)
  state.orgs = (data || []).map(r => ({ ...r.organizations, orgRole: r.role }))
  // Default to first org
  if (state.orgs.length && !state.org) {
    state.org = state.orgs[0]
  }
}

// ── Workspace CRUD ───────────────────────────────────────────────────────────

async function loadWorkspaces() {
  if (!state.user) return
  const { data } = await supabase
    .from('workspace_members')
    .select('workspace_id, role, workspaces(id, name, created_at, org_id)')
    .eq('user_id', state.user.id)
  // Filter to current org if one is selected
  const all = (data || []).map(r => ({ ...r.workspaces, role: r.role }))
  state.workspaces = state.org
    ? all.filter(w => w.org_id === state.org.id)
    : all
}

async function createWorkspace(name) {
  const { data: ws, error } = await supabase
    .from('workspaces')
    .insert({ name, created_by: state.user.id, org_id: state.org?.id || null })
    .select()
    .single()
  if (error) throw new Error(error.message)

  await supabase.from('workspace_members').insert({
    workspace_id: ws.id, user_id: state.user.id, role: 'owner'
  })

  // Seed default views
  const defaults = defaultViewTemplates()
  for (const view of defaults) {
    await supabase.from('diagram_views').insert({
      workspace_id: ws.id, owner_id: state.user.id, ...view
    })
  }

  // Seed default memory
  const memDefaults = {
    'environment.md': { content: '# Environment\n\nTech stack, infrastructure, key identifiers.\n', visibility: 'shared' },
    'logic.md': { content: '# Logic\n\nBusiness logic, architecture decisions.\n', visibility: 'shared' },
    'people.md': { content: '# People\n\nOwnership, stakeholders, tribal knowledge.\n', visibility: 'shared' },
    'session-log.md': { content: '# Session Log\n', visibility: 'private' }
  }
  for (const [filename, { content, visibility }] of Object.entries(memDefaults)) {
    await supabase.from('memory_notes').insert({
      workspace_id: ws.id, filename, content, visibility, owner_id: state.user.id
    })
  }

  return ws
}

async function openWorkspace(workspaceId) {
  state.workspaceId = workspaceId
  await refreshWorkspace()
  setupRealtimeSubscription()

  // Track active workspace so the hook auto-loads it next session
  if (state.org?.id) {
    void supabase.from('org_members')
      .update({ active_workspace_id: workspaceId })
      .eq('org_id', state.org.id)
      .eq('user_id', state.user.id)
  }

  setWorkspaceStatus('Workspace open. Claude Code can connect via Delma MCP.')
  appendLog('Workspace Open', `Connected to workspace. Diagrams and memory are live.`)
}

// ── Data Loading ─────────────────────────────────────────────────────────────

async function refreshWorkspace() {
  if (!state.workspaceId || !state.user) return

  // Fetch workspace + org data + user's role in parallel
  const queries = [
    supabase.from('diagram_views').select('*').eq('workspace_id', state.workspaceId).order('view_key'),
    supabase.from('memory_notes').select('*').eq('workspace_id', state.workspaceId),
    supabase.from('history_snapshots').select('id, reason, created_at')
      .eq('workspace_id', state.workspaceId).order('created_at', { ascending: false }).limit(30),
    supabase.from('workspaces').select('name, org_id').eq('id', state.workspaceId).single(),
    supabase.from('workspace_members').select('role')
      .eq('workspace_id', state.workspaceId).eq('user_id', state.user.id).single()
  ]

  // Also fetch org-level memory notes if we have an org
  if (state.org?.id) {
    queries.push(supabase.from('org_memory_notes').select('*').eq('org_id', state.org.id))
  }

  const results = await Promise.all(queries)
  const [{ data: views }, { data: memoryRows }, { data: history }, { data: ws }, { data: membership }] = results
  const orgMemoryRows = results[5]?.data || []

  state.userRole = membership?.role || 'member'
  state.views = views || []
  state.memoryRows = memoryRows || []
  state.memory = {}
  for (const row of state.memoryRows) state.memory[row.filename] = row.content
  state.orgMemoryRows = orgMemoryRows
  state.orgMemory = {}
  for (const row of state.orgMemoryRows) state.orgMemory[row.filename] = row.content
  state.history = (history || []).map(h => `${h.created_at} — ${h.reason}`)
  state.workspaceName = ws?.name || ''

  if (!state.activeViewKey || !state.views.some(v => v.view_key === state.activeViewKey)) {
    state.activeViewKey = state.views[0]?.view_key || null
  }

  const active = getActiveView()
  state.previewMermaid = active?.mermaid || ''
  renderWorkspace()
}

// ── Supabase Realtime ────────────────────────────────────────────────────────

let realtimeChannel = null

function setupRealtimeSubscription() {
  if (realtimeChannel) supabase.removeChannel(realtimeChannel)

  realtimeChannel = supabase
    .channel(`workspace-${state.workspaceId}`)
    .on('postgres_changes', {
      event: '*',
      schema: 'public',
      table: 'diagram_views',
      filter: `workspace_id=eq.${state.workspaceId}`
    }, () => void refreshWorkspace())
    .on('postgres_changes', {
      event: '*',
      schema: 'public',
      table: 'memory_notes',
      filter: `workspace_id=eq.${state.workspaceId}`
    }, () => void refreshWorkspace())
    .subscribe()
}

// ── Diagram Mode ─────────────────────────────────────────────────────────────

function setDiagramMode(mode) {
  state.diagramMode = mode
  els.modeToggle.hidden = false
  els.viewModeBtn.classList.toggle('active', mode === 'view')
  els.editModeBtn.classList.toggle('active', mode === 'edit')
  els.diagramOutput.hidden = mode === 'edit'
  els.diagramEditor.classList.toggle('visible', mode === 'edit')
}

// ── View Helpers ─────────────────────────────────────────────────────────────

function getActiveView() {
  if (!state.views.length) return defaultViewTemplates()[0]
  return state.views.find(v => v.view_key === state.activeViewKey) || state.views[0] || null
}

async function renderDiagram(mermaidCode) {
  if (!mermaidCode?.trim()) {
    els.diagramOutput.className = 'diagram-empty'
    els.diagramOutput.textContent = 'This view does not have Mermaid content yet.'
    return true
  }
  try {
    const renderId = `delma-diagram-${Date.now()}`
    const { svg } = await mermaid.render(renderId, mermaidCode)
    els.diagramOutput.className = ''
    els.diagramOutput.innerHTML = svg
    return true
  } catch (error) {
    els.diagramOutput.className = 'diagram-error'
    els.diagramOutput.innerHTML = `<div class="diagram-error-title">Mermaid syntax error</div><pre class="diagram-error-detail">${escapeHtml(error.message)}</pre>`
    return false
  }
}

async function validateCurrentMermaid() {
  const code = els.diagramEditor.value || els.viewMermaid.value
  if (!code?.trim()) return true
  try {
    await mermaid.render(`delma-validate-${Date.now()}`, code)
    return true
  } catch { return false }
}

// ── Markdown + Mermaid Renderer ──────────────────────────────────────────────

async function renderMarkdownWithMermaid(container, markdownText) {
  // Parse markdown to HTML
  let html = marked.parse(markdownText)

  // Find all <code class="language-mermaid"> blocks and replace with placeholders
  const mermaidBlocks = []
  html = html.replace(/<pre><code class="language-mermaid">([\s\S]*?)<\/code><\/pre>/g, (match, code) => {
    const id = `mermaid-block-${Date.now()}-${mermaidBlocks.length}`
    mermaidBlocks.push({ id, code: decodeHtmlEntities(code.trim()) })
    return `<div id="${id}" class="mermaid-inline"></div>`
  })

  container.innerHTML = html

  // Render each mermaid block
  for (const block of mermaidBlocks) {
    const el = container.querySelector(`#${block.id}`)
    if (!el) continue
    try {
      const { svg } = await mermaid.render(`render-${block.id}`, block.code)
      el.innerHTML = svg
    } catch (e) {
      el.innerHTML = `<pre style="color:#999;font-size:12px;">(diagram error: ${escapeHtml(e.message)})</pre>`
    }
  }
}

function decodeHtmlEntities(str) {
  const el = document.createElement('textarea')
  el.innerHTML = str
  return el.value
}

/**
 * Strip Mermaid YAML frontmatter (---\nconfig:...\n---) from display.
 * Mermaid itself reads this config, but it looks ugly rendered as text.
 * We keep it in the source for Mermaid to parse, but strip it from
 * any text-based display.
 */
function stripMermaidConfig(code) {
  return code.replace(/^---\n[\s\S]*?\n---\n?/, '').trim()
}

// ── Tab Labels for Memory Files ──────────────────────────────────────────────

// Project-level tab labels (workspace-scoped)
const MEMORY_TAB_LABELS = {
  'project-details.md': { title: 'Project Details', desc: 'Campaign-specific IDs, journeys, automations, CloudPages.' },
  'logic.md': { title: 'Campaign Logic', desc: 'Business rules, routing, how the campaign works.' },
  'session-log.md': { title: 'Session Log', desc: 'Current status, what\'s done, what\'s needed.' }
}

// Org-level tab labels (shared across all projects)
const ORG_TAB_LABELS = {
  'sfmc-setup.md': { title: 'SFMC Setup', desc: 'API credentials, send config, shared DEs. Same across all campaigns.' },
  'people.md': { title: 'People', desc: 'Team members, roles, ownership. Same across all projects.' }
}

// ── Render ───────────────────────────────────────────────────────────────────

function renderViewTabs() {
  els.viewTabs.textContent = ''

  // ── Org-level tabs (shared across all projects) ────────────────────────
  const orgFiles = Object.keys(state.orgMemory).length ? Object.keys(state.orgMemory) : []
  for (const filename of orgFiles) {
    const label = ORG_TAB_LABELS[filename] || { title: filename, desc: '' }
    const row = state.orgMemoryRows.find(r => r.filename === filename)
    const editable = row ? canEditItem(row) : true
    const isActive = state.activeTopTab === 'orgMemory' && state.activeMemoryFile === filename
    const btn = document.createElement('button')
    btn.className = `view-tab${isActive ? ' active' : ''}`
    btn.innerHTML = `<div class="view-tab-title">${editable ? '' : '<span style="opacity:0.4;margin-right:3px;">&#128274;</span>'}${escapeHtml(label.title)}</div>`
    btn.addEventListener('click', () => {
      saveCurrentEditState()
      state.activeTopTab = 'orgMemory'
      state.activeMemoryFile = filename
      renderWorkspace()
    })
    els.viewTabs.appendChild(btn)
  }

  // Separator between org and project tabs
  if (orgFiles.length) {
    const sep = document.createElement('span')
    sep.style.cssText = 'width:1px;height:20px;background:rgba(0,0,0,0.12);flex-shrink:0;'
    els.viewTabs.appendChild(sep)
  }

  // ── Project-level tabs ─────────────────────────────────────────────────

  // Diagram tabs
  const views = state.views.length ? state.views : defaultViewTemplates()
  for (const view of views) {
    const btn = document.createElement('button')
    const key = view.view_key
    const editable = canEditItem(view)
    const isActive = state.activeTopTab === 'diagram' && key === state.activeViewKey
    btn.className = `view-tab${isActive ? ' active' : ''}`
    btn.innerHTML = `<div class="view-tab-title">${editable ? '' : '<span style="opacity:0.4;margin-right:3px;">&#128274;</span>'}${escapeHtml(view.title)}</div>`
    btn.addEventListener('click', () => {
      saveCurrentEditState()
      state.activeTopTab = 'diagram'
      state.activeViewKey = key
      state.previewMermaid = view.mermaid || ''
      renderWorkspace()
    })
    els.viewTabs.appendChild(btn)
  }

  // Project memory tabs
  const memFiles = Object.keys(state.memory).length ? Object.keys(state.memory) : Object.keys(MEMORY_TAB_LABELS)
  for (const filename of memFiles) {
    const label = MEMORY_TAB_LABELS[filename] || { title: filename, desc: '' }
    const row = state.memoryRows.find(r => r.filename === filename)
    const editable = row ? canEditItem(row) : true
    const isActive = state.activeTopTab === 'memory' && state.activeMemoryFile === filename
    const btn = document.createElement('button')
    btn.className = `view-tab${isActive ? ' active' : ''}`
    btn.innerHTML = `<div class="view-tab-title">${editable ? '' : '<span style="opacity:0.4;margin-right:3px;">&#128274;</span>'}${escapeHtml(label.title)}</div>`
    btn.addEventListener('click', () => {
      saveCurrentEditState()
      state.activeTopTab = 'memory'
      state.activeMemoryFile = filename
      renderWorkspace()
    })
    els.viewTabs.appendChild(btn)
  }
}

function populateEditor(view) {
  els.viewTitleInput.value = view?.title || ''
  els.viewDescriptionInput.value = view?.description || ''
  els.viewSummaryInput.value = view?.summary || ''
  els.viewMermaid.value = state.previewMermaid || view?.mermaid || ''
  els.diagramEditor.value = state.previewMermaid || view?.mermaid || ''
}

// ── Render a memory file as a readable document ─────────────────────────────

async function renderMemoryDocument(filename, isOrg = false) {
  const content = isOrg ? (state.orgMemory[filename] || '') : (state.memory[filename] || '')
  const label = (isOrg ? ORG_TAB_LABELS[filename] : MEMORY_TAB_LABELS[filename]) || { title: filename, desc: '' }
  const row = isOrg
    ? state.orgMemoryRows.find(r => r.filename === filename)
    : state.memoryRows.find(r => r.filename === filename)
  const editable = row ? canEditItem(row) : true

  els.viewTitle.textContent = label.title
  els.viewDescription.textContent = editable
    ? label.desc
    : `${label.desc} (read-only)`
  els.resetExampleBtn.hidden = true

  // Hide Edit button if user can't edit this tab
  els.modeToggle.hidden = !editable
  if (!editable && state.diagramMode === 'edit') state.diagramMode = 'view'

  if (state.diagramMode === 'edit' && editable) {
    els.diagramOutput.hidden = true
    els.diagramEditor.classList.add('visible')
    els.diagramEditor.value = content
  } else {
    els.diagramOutput.hidden = false
    els.diagramEditor.classList.remove('visible')
    els.diagramOutput.className = 'documentation-shell markdown-body'
    await renderMarkdownWithMermaid(els.diagramOutput, content.trim() || '*(empty)*')
  }
}

// ── Render the overview tab (diagrams + memory summary) ─────────────────────

// ── Main renderWorkspace ────────────────────────────────────────────────────

function renderWorkspace() {
  renderViewTabs()

  // Org memory tab (SFMC Setup, People)
  if (state.activeTopTab === 'orgMemory') {
    void renderMemoryDocument(state.activeMemoryFile, true)
    return
  }

  // Project memory tab
  if (state.activeTopTab === 'memory') {
    void renderMemoryDocument(state.activeMemoryFile)
    return
  }

  // Diagram tab — render as markdown with mermaid block
  const view = getActiveView()
  if (!view) {
    els.diagramOutput.className = 'documentation-shell'
    els.diagramOutput.textContent = 'No view loaded.'
    return
  }

  const editable = canEditItem(view)

  // Hide Edit button if user can't edit this diagram
  els.modeToggle.hidden = !editable
  els.resetExampleBtn.hidden = !editable
  if (!editable && state.diagramMode === 'edit') state.diagramMode = 'view'

  els.viewTitle.textContent = view.title
  els.viewDescription.textContent = editable
    ? (view.description || '')
    : `${view.description || ''} (read-only)`
  populateEditor(view)
  setDiagramMode(state.diagramMode)

  if (state.diagramMode !== 'edit') {
    const mermaidCode = state.previewMermaid || view.mermaid || ''
    const md = `\`\`\`mermaid\n${mermaidCode}\n\`\`\``
    els.diagramOutput.className = 'documentation-shell markdown-body'
    void renderMarkdownWithMermaid(els.diagramOutput, md)
  }
}

// ── Edit State ───────────────────────────────────────────────────────────────

function saveCurrentEditState() {
  if (state.diagramMode !== 'edit') return
  if (state.activeTopTab === 'orgMemory') {
    state.orgMemory[state.activeMemoryFile] = els.diagramEditor.value
  } else if (state.activeTopTab === 'memory') {
    state.memory[state.activeMemoryFile] = els.diagramEditor.value
  } else if (state.activeTopTab === 'diagram') {
    updateActiveViewFromEditor()
  }
}

function updateActiveViewFromEditor() {
  const view = getActiveView()
  if (!view) return
  const nextMermaid = els.diagramEditor.value || els.viewMermaid.value
  view.title = els.viewTitleInput.value.trim() || view.title
  view.description = els.viewDescriptionInput.value.trim()
  view.summary = els.viewSummaryInput.value.trim()
  view.mermaid = nextMermaid
  state.previewMermaid = view.mermaid
  els.viewMermaid.value = nextMermaid
}

// ── Save to Supabase ─────────────────────────────────────────────────────────

async function saveCurrentTab() {
  if (!state.workspaceId) return

  // Save org-level memory tab
  if (state.activeTopTab === 'orgMemory') {
    const filename = state.activeMemoryFile
    const content = els.diagramEditor.value
    state.orgMemory[filename] = content

    const { data: existing } = await supabase
      .from('org_memory_notes')
      .select('id')
      .eq('org_id', state.org.id)
      .eq('filename', filename)
      .single()

    if (existing) {
      await supabase.from('org_memory_notes').update({ content }).eq('id', existing.id)
    } else {
      await supabase.from('org_memory_notes').insert({
        org_id: state.org.id, filename, content, permission: 'edit-all', owner_id: state.user.id
      })
    }

    await refreshWorkspace()
    setWorkspaceStatus(`Saved ${ORG_TAB_LABELS[filename]?.title || filename}.`)
    return
  }

  // Save project-level memory tab
  if (state.activeTopTab === 'memory') {
    // Save memory file
    const filename = state.activeMemoryFile
    const content = els.diagramEditor.value
    state.memory[filename] = content

    const { data: existing } = await supabase
      .from('memory_notes')
      .select('id')
      .eq('workspace_id', state.workspaceId)
      .eq('filename', filename)
      .or(`visibility.eq.shared,owner_id.eq.${state.user.id}`)
      .single()

    if (existing) {
      await supabase.from('memory_notes').update({ content }).eq('id', existing.id)
    } else {
      const visibility = filename === 'session-log.md' ? 'private' : 'shared'
      await supabase.from('memory_notes').insert({
        workspace_id: state.workspaceId, filename, content, visibility, owner_id: state.user.id
      })
    }

    await refreshWorkspace()
    setWorkspaceStatus(`Saved ${MEMORY_TAB_LABELS[filename]?.title || filename}.`)
    return
  }

  if (state.activeTopTab === 'diagram') {
    const view = getActiveView()
    if (!view) return
    updateActiveViewFromEditor()

    const { error } = await supabase
      .from('diagram_views')
      .update({ title: view.title, description: view.description, summary: view.summary, mermaid: view.mermaid })
      .eq('id', view.id)

    if (error) throw new Error(error.message)

    await supabase.from('history_snapshots').insert({
      workspace_id: state.workspaceId,
      reason: `save-${view.view_key}`,
      snapshot: { view },
      created_by: state.user.id
    })

    await refreshWorkspace()
    setWorkspaceStatus('Saved.')
  }
}

// ── Org & Project Selectors ──────────────────────────────────────────────────

const orgSelector = document.getElementById('org-selector')
const projectSelector = document.getElementById('project-selector')
const newProjectBtn = document.getElementById('new-project-btn')

function renderOrgSelector() {
  orgSelector.innerHTML = ''
  if (!state.orgs.length) {
    orgSelector.innerHTML = '<option value="">No organizations</option>'
    return
  }
  for (const org of state.orgs) {
    const opt = document.createElement('option')
    opt.value = org.id
    opt.textContent = org.name
    if (state.org?.id === org.id) opt.selected = true
    orgSelector.appendChild(opt)
  }
}

function renderProjectSelector() {
  projectSelector.innerHTML = ''
  if (!state.workspaces.length) {
    projectSelector.innerHTML = '<option value="">No projects</option>'
    return
  }
  for (const ws of state.workspaces) {
    const opt = document.createElement('option')
    opt.value = ws.id
    opt.textContent = ws.name
    if (state.workspaceId === ws.id) opt.selected = true
    projectSelector.appendChild(opt)
  }
}

orgSelector.addEventListener('change', () => {
  void (async () => {
    const orgId = orgSelector.value
    state.org = state.orgs.find(o => o.id === orgId) || null
    await loadWorkspaces()
    renderProjectSelector()
    if (state.workspaces.length) {
      await openWorkspace(state.workspaces[0].id)
    } else {
      state.workspaceId = null
      renderWorkspace()
    }
  })().catch(err => setWorkspaceStatus(err.message))
})

projectSelector.addEventListener('change', () => {
  void (async () => {
    const wsId = projectSelector.value
    if (wsId) await openWorkspace(wsId)
  })().catch(err => setWorkspaceStatus(err.message))
})

newProjectBtn.addEventListener('click', () => {
  const name = prompt('New project name:')
  if (!name?.trim()) return
  void (async () => {
    const ws = await createWorkspace(name.trim())
    state.workspaces.push({ ...ws, role: 'owner' })
    renderProjectSelector()
    await openWorkspace(ws.id)
    setWorkspaceStatus(`Created "${ws.name}".`)
  })().catch(err => setWorkspaceStatus(err.message))
})

// ── Event Listeners ──────────────────────────────────────────────────────────

els.saveWorkspaceBtn.addEventListener('click', () => {
  void saveCurrentTab().catch(err => {
    setWorkspaceStatus(err.message)
    appendLog('Save Failed', err.message, 'error')
  })
})

els.viewModeBtn.addEventListener('click', () => {
  saveCurrentEditState()
  setDiagramMode('view')
  renderWorkspace()
})

els.editModeBtn.addEventListener('click', () => {
  setDiagramMode('edit')
  renderWorkspace()
  setWorkspaceStatus('Edit mode — make changes, then save.')
})

els.diagramEditor.addEventListener('input', () => {
  if (state.activeTopTab === 'orgMemory') {
    state.orgMemory[state.activeMemoryFile] = els.diagramEditor.value
  } else if (state.activeTopTab === 'memory') {
    state.memory[state.activeMemoryFile] = els.diagramEditor.value
  } else if (state.activeTopTab === 'diagram') {
    state.previewMermaid = els.diagramEditor.value
    els.viewMermaid.value = els.diagramEditor.value
  }
})

els.previewBtn.addEventListener('click', () => {
  updateActiveViewFromEditor()
  renderWorkspace()
  setWorkspaceStatus('Preview updated. Save when ready.')
})

els.saveViewBtn.addEventListener('click', () => {
  void (async () => {
    if (state.activeTopTab === 'diagram') {
      const valid = await validateCurrentMermaid()
      if (!valid) {
        updateActiveViewFromEditor()
        renderWorkspace()
        setWorkspaceStatus('Fix the Mermaid syntax error before saving.')
        return
      }
    }
    await saveCurrentTab()
  })().catch(err => {
    setWorkspaceStatus(err.message)
    appendLog('Save Failed', err.message, 'error')
  })
})

els.resetExampleBtn.addEventListener('click', () => {
  const templates = defaultViewTemplates()
  const tpl = templates.find(v => v.view_key === state.activeViewKey)
  if (!tpl) return
  const view = getActiveView()
  if (view) Object.assign(view, tpl)
  state.previewMermaid = tpl.mermaid
  els.diagramEditor.value = tpl.mermaid
  renderWorkspace()
  setWorkspaceStatus('Reset to default template.')
})

els.authForm.addEventListener('submit', (e) => {
  e.preventDefault()
  const email = els.authUsername.value.trim()
  const password = els.authPassword.value

  void (async () => {
    try {
      await login(email, password)
    } catch (loginErr) {
      // If login fails, try signup
      if (loginErr.message.includes('Invalid login')) {
        try {
          await signup(email, password)
          appendLog('Account Created', 'Signed up and logged in.')
        } catch (signupErr) {
          els.authError.textContent = signupErr.message
          return
        }
      } else {
        els.authError.textContent = loginErr.message
        return
      }
    }
    els.authError.textContent = ''
    els.authPassword.value = ''
    setWorkspaceStatus('Signed in.')
    appendLog('Signed In', 'Workspace and memory tools available.')
    await loadOrgs()
    await loadWorkspaces()
    renderOrgSelector()
    renderProjectSelector()
    if (state.workspaces.length) {
      await openWorkspace(state.workspaces[0].id)
    }
  })()
})

els.logoutBtn.addEventListener('click', () => {
  void logout().then(() => {
    setWorkspaceStatus('Signed out.')
  })
})

// ── Default Templates ────────────────────────────────────────────────────────

function defaultViewTemplates() {
  return [
    {
      view_key: 'architecture',
      title: 'Architecture',
      kind: 'architecture',
      description: 'How systems, integrations, and automation surfaces connect.',
      summary: 'Technical architecture.',
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
  Delma["Delma Memory"] --> Claude["Claude Code"]
  Claude --> Sync
`
    }
  ]
}

// ── Init ─────────────────────────────────────────────────────────────────────

async function init() {
  els.sdkStatus.textContent = 'Checking auth...'
  els.connectBtn.textContent = 'Open Workspace'
  els.input.disabled = true
  els.sendBtn.disabled = true

  if (els.authCopy) els.authCopy.textContent = 'Sign in with your email and password.'
  if (els.authUsername) els.authUsername.placeholder = 'Email'
  if (els.projectDir) els.projectDir.placeholder = 'Workspace name'

  // Show default templates before auth
  renderWorkspace()

  const user = await checkAuth()
  if (user) {
    await loadOrgs()
    await loadWorkspaces()
    renderOrgSelector()
    renderProjectSelector()
    if (state.workspaces.length) {
      await openWorkspace(state.workspaces[0].id)
    } else {
      setWorkspaceStatus('Create a project to get started.')
    }
  }
}

void init()
