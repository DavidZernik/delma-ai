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
import { ROUTER_SYSTEM_PROMPT, buildTabsBlock, buildRouterUserMessage } from './router-prompt.js'
import { extractJsonArray } from './extract-json-array.js'
import { isStructuredTab } from './tab-ops.js'
import { renderStructuredEditor } from './structured-editor.js'
import { mountChat } from './chat/mount.js'

// Helper: get the current user's Supabase JWT for authenticated server calls.
// Server endpoints verify this token and never trust a client-supplied userId.
async function authHeaders() {
  const { data: { session } } = await supabase.auth.getSession()
  const token = session?.access_token
  return token ? { Authorization: `Bearer ${token}` } : {}
}

// Save the markdown editor's content for a structured tab. The server
// re-parses markdown → JSON so the structured column stays canonical.
async function postStructuredSave(tabKey, content) {
  console.log('[delma save] structured tab', tabKey, 'len:', content.length)
  const headers = { 'Content-Type': 'application/json', ...(await authHeaders()) }
  const res = await fetch('/api/save-structured-tab', {
    method: 'POST',
    headers,
    body: JSON.stringify({
      tabKey, content,
      workspaceId: state.workspaceId,
      orgId: state.org?.id
    })
  })
  if (!res.ok) {
    const err = await res.json().catch(() => ({}))
    throw new Error(err.error || `save failed (${res.status})`)
  }
  return res.json()
}

mermaid.registerLayoutLoaders(elkLayouts)
mermaid.initialize({
  startOnLoad: false,
  securityLevel: 'loose',
  theme: 'base',
  layout: 'elk',
  flowchart: { curve: 'basis', padding: 8, nodeSpacing: 24, rankSpacing: 48 },
  themeVariables: {
    primaryColor: '#FFFFFF',
    primaryTextColor: '#0F0A0A',   // sharper than ink, near-black for max contrast
    primaryBorderColor: '#EFE4DE', // softer than --line so text > border visually
    secondaryColor: '#FFFFFF',
    secondaryTextColor: '#0F0A0A',
    secondaryBorderColor: '#EFE4DE',
    tertiaryColor: '#FFFEEE',
    tertiaryTextColor: '#0F0A0A',
    tertiaryBorderColor: '#EFE4DE',
    lineColor: '#8F0000',          // arrows — red
    textColor: '#0F0A0A',
    fontSize: '15px',
    fontFamily: '"Instrument Sans", "Avenir Next", "Segoe UI", sans-serif',
    nodeBorder: '#EFE4DE',
    nodeTextColor: '#0F0A0A',
    mainBkg: '#FFFFFF',
    edgeLabelBackground: '#FFFFFF',
    clusterBkg: '#FFFEEE',
    clusterBorder: '#EFE4DE'
  }
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
  editStrip: document.getElementById('edit-strip'),
  viewTabs: document.getElementById('view-tabs'),
  historyList: document.getElementById('history-list'),
  memoryList: document.getElementById('memory-list'),
  viewTitle: document.getElementById('view-title'),
  viewDescription: document.getElementById('view-description'),
  viewProvenance: document.getElementById('view-provenance'),
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

function timeAgo(dateStr) {
  if (!dateStr) return ''
  const diff = Date.now() - new Date(dateStr).getTime()
  const mins = Math.floor(diff / 60000)
  if (mins < 1) return 'just now'
  if (mins < 60) return `${mins}m ago`
  const hrs = Math.floor(mins / 60)
  if (hrs < 24) return `${hrs}h ago`
  const days = Math.floor(hrs / 24)
  return `${days}d ago`
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
  console.log('[delma auth] checking...')
  const { data: { user } } = await supabase.auth.getUser()
  state.user = user
  setAuthUi(!!user)
  console.log('[delma auth]', user ? `logged in: ${user.email}` : 'not logged in')
  return user
}

async function login(email, password) {
  console.log('[delma auth] login attempt:', email)
  const { data, error } = await supabase.auth.signInWithPassword({ email, password })
  if (error) { console.error('[delma auth] login failed:', error.message); throw new Error(error.message) }
  state.user = data.user
  setAuthUi(true)
  console.log('[delma auth] login success:', data.user.email)
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
  const { data, error } = await supabase
    .from('org_members')
    .select('org_id, role, organizations(id, name, slug)')
    .eq('user_id', state.user.id)
  state.orgs = (data || []).map(r => ({ ...r.organizations, orgRole: r.role }))
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

  // Seed default memory tabs (current vocabulary only):
  //   environment.md → "Files Locations and Keys"
  //   decisions.md   → "Project Details"
  // (people.md + playbook.md live at the org level, my-notes.md is global per-user)
  const memDefaults = {
    'environment.md': {
      content: '# Files Locations and Keys\n\nSFMC Business Unit, MIDs, Data Extensions, Journeys, Automations, CloudPages, and other project-specific IDs.\n',
      visibility: 'shared',
      permission: 'view-admins'
    },
    'decisions.md': {
      content: '# Project Details\n\n## Decisions\n- _What\'s been decided._\n\n## Actions\n- _What needs to happen next._\n',
      visibility: 'shared',
      permission: 'edit-all'
    }
  }
  for (const [filename, { content, visibility, permission }] of Object.entries(memDefaults)) {
    await supabase.from('memory_notes').insert({
      workspace_id: ws.id, filename, content, visibility, permission, owner_id: state.user.id
    })
  }

  return ws
}

async function openWorkspace(workspaceId) {
  console.log('[delma workspace] opening:', workspaceId)
  state.workspaceId = workspaceId
  dismissedTabs.clear()  // Reset dismissed prompts for new workspace
  await refreshWorkspace()
  setupRealtimeSubscription()
  console.log('[delma workspace] open complete, views:', state.views.length, 'realtime subscribed')

  // Track active workspace so the hook auto-loads it next session AND so
  // any in-flight Claude Code session sees the project change on the next
  // message via refreshed CLAUDE.md.
  if (state.org?.id) {
    void supabase.from('org_members')
      .update({ active_workspace_id: workspaceId })
      .eq('org_id', state.org.id)
      .eq('user_id', state.user.id)
      .then(() => {
        // Regenerate CLAUDE.md for the NEW active workspace so Claude
        // (mid-session) sees the project switch on the next message.
        triggerClaudeMdRefresh()
      })
  }

  setWorkspaceStatus('Workspace open. Claude Code can connect via Delma MCP.')
  appendLog('Workspace Open', `Connected to workspace. Diagrams and memory are live.`)

  // Mount the in-app chat. Agent SDK runs server-side; sidebar streams its
  // output. Chat lives alongside the workspace — same app, no Claude Desktop.
  if (state.user?.id && state.workspaceId) {
    try { mountChat({ containerId: 'chat-sidebar-root', workspaceId: state.workspaceId, userId: state.user.id }) }
    catch (err) { console.warn('[delma chat] mount failed:', err.message) }
  }
}

// ── Data Loading ─────────────────────────────────────────────────────────────

async function refreshWorkspace() {
  if (!state.workspaceId || !state.user) {
    console.log('[delma refresh] skipped — no workspace or user')
    return
  }

  console.log('[delma refresh] fetching from Supabase, workspace:', state.workspaceId)
  const t0 = performance.now()

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

  // Check for errors on each query
  const labels = ['diagram_views', 'memory_notes', 'history', 'workspace', 'membership']
  results.forEach((r, i) => {
    if (r.error) console.error(`[delma refresh] ${labels[i] || 'org_memory'} query error:`, r.error.message)
  })

  const [{ data: views }, { data: memoryRows }, { data: history }, { data: ws }, { data: membership }] = results
  const orgMemoryRows = results[5]?.data || []

  state.userRole = membership?.role || 'member'
  state.views = views || []
  state.memoryRows = memoryRows || []
  state.memory = {}
  for (const row of state.memoryRows) {
    state.memory[row.filename] = row.content
    console.log(`[delma refresh] memory tab: ${row.filename} — ${(row.content || '').length} chars, structured: ${row.structured ? 'yes' : 'no'}`)
  }
  state.orgMemoryRows = orgMemoryRows
  state.orgMemory = {}
  for (const row of state.orgMemoryRows) {
    state.orgMemory[row.filename] = row.content
    console.log(`[delma refresh] org tab: ${row.filename} — ${(row.content || '').length} chars`)
  }
  state.history = (history || []).map(h => `${h.created_at} — ${h.reason}`)
  state.workspaceName = ws?.name || ''

  if (!state.activeViewKey || !state.views.some(v => v.view_key === state.activeViewKey)) {
    state.activeViewKey = state.views[0]?.view_key || null
  }

  // Load global My Notes (per-user, follows across orgs/projects).
  // Falls back gracefully if the user_notes table isn't migrated yet.
  await loadGlobalNotes()

  const active = getActiveView()
  state.previewMermaid = active?.mermaid || ''
  console.log('[delma refresh] done in', Math.round(performance.now() - t0), 'ms | views:', state.views.length, 'memory:', Object.keys(state.memory).length, 'orgMemory:', Object.keys(state.orgMemory).length, 'activeView:', active?.view_key, 'mermaidLen:', state.previewMermaid.length)
  renderWorkspace()
}

// ── Global My Notes (per-user, not per-project) ─────────────────────────────
async function loadGlobalNotes() {
  if (!state.user) { state.globalNotes = ''; return }
  const { data, error } = await supabase
    .from('user_notes')
    .select('content')
    .eq('user_id', state.user.id)
    .maybeSingle()
  if (error) {
    console.warn('[delma notes] user_notes table not ready:', error.message)
    state.globalNotes = ''
    state.globalNotesUnavailable = true
    return
  }
  state.globalNotes = data?.content || ''
  state.globalNotesUnavailable = false
  console.log('[delma notes] loaded global notes,', state.globalNotes.length, 'chars')
}

async function saveGlobalNotes(content) {
  if (!state.user) return
  console.log('[delma notes] saving global notes,', content.length, 'chars')
  const { error } = await supabase
    .from('user_notes')
    .upsert({ user_id: state.user.id, content, updated_at: new Date().toISOString() })
  if (error) {
    console.error('[delma notes] save failed:', error.message)
    setWorkspaceStatus(`Couldn't save notes: ${error.message}`)
    return
  }
  state.globalNotes = content
}

// ── Supabase Realtime ────────────────────────────────────────────────────────
// When Claude or another user writes to Delma:
//   - If the changed tab is active → re-render with fade transition
//   - If the changed tab is inactive → show a notification dot on the tab pill

let realtimeChannel = null
const tabsWithUpdates = new Set()

function getTabKeyForChange(table, record) {
  if (table === 'diagram_views') return `dia:${record.view_key}`
  if (table === 'memory_notes') return `mem:${record.filename}`
  if (table === 'org_memory_notes') return `org:${record.filename}`
  return ''
}

function isCurrentTab(tabKey) {
  if (state.activeTopTab === 'diagram') return tabKey === `dia:${state.activeViewKey}`
  if (state.activeTopTab === 'memory') return tabKey === `mem:${state.activeMemoryFile}`
  if (state.activeTopTab === 'orgMemory') return tabKey === `org:${state.activeMemoryFile}`
  return false
}

// Flash the actual visible content. Strategy:
//   - For Mermaid diagrams: target the <svg> directly so the wash hugs the
//     diagram bounds and doesn't bleed into the empty zoom canvas.
//   - For markdown prose: target the .diagram-shell (the visible card), since
//     diagramOutput can be wider than the prose and hasno clear bounds.
function flashContentUpdate() {
  const output = els.diagramOutput
  const svg = output.querySelector('.diagram-zoom-canvas svg')
  const shell = output.closest('.diagram-shell')

  const outputRect = output.getBoundingClientRect()
  const svgRect = svg?.getBoundingClientRect()
  const shellRect = shell?.getBoundingClientRect()

  console.log('[delma flash] output size:', { w: Math.round(outputRect.width), h: Math.round(outputRect.height) })
  if (svg) console.log('[delma flash] svg size:', { w: Math.round(svgRect.width), h: Math.round(svgRect.height) })
  if (shell) console.log('[delma flash] shell size:', { w: Math.round(shellRect.width), h: Math.round(shellRect.height) })

  const target = svg || shell || output
  const targetName = svg ? '<svg>' : shell ? '.diagram-shell' : '#diagram-output'
  console.log('[delma flash] applying to:', targetName)

  target.classList.add('content-updated-flash')
  setTimeout(() => {
    target.classList.remove('content-updated-flash')
    console.log('[delma flash] removed from', targetName)
  }, 4100)
}

function handleRealtimeChange(table, payload) {
  const record = payload.new || payload.old || {}
  const tabKey = getTabKeyForChange(table, record)
  console.log('[delma realtime] change:', table, tabKey, 'current:', isCurrentTab(tabKey), 'mode:', state.diagramMode)

  // Any external change also resets dismissed + starts grace window
  noteTabChanged(tabKey)

  if (isCurrentTab(tabKey)) {
    if (state.diagramMode === 'edit') {
      // In edit mode — don't overwrite the editor, but show a notification
      console.log('[delma realtime] in edit mode, showing update banner')
      setWorkspaceStatus('Content updated externally — save or cancel to see changes.')
      return
    }

    // View mode — fade and re-render
    els.diagramOutput.style.transition = 'opacity 150ms ease'
    els.diagramOutput.style.opacity = '0.3'
    refreshWorkspace().then(() => {
      requestAnimationFrame(() => {
        els.diagramOutput.style.transition = 'opacity 400ms ease'
        els.diagramOutput.style.opacity = '1'
        flashContentUpdate()
        console.log('[delma realtime] view refreshed with flash')
      })
    }).catch(err => {
      console.error('[delma realtime] refresh failed:', err)
      els.diagramOutput.style.opacity = '1'
    })
  } else {
    // Different tab — mark it with a dot
    tabsWithUpdates.add(tabKey)
    renderViewTabs()
    refreshWorkspace().catch(err => console.error('[delma realtime] bg refresh failed:', err))
    console.log('[delma realtime] inactive tab dotted:', tabKey)
  }
}

function setupRealtimeSubscription() {
  console.log('[delma realtime] setting up subscriptions for workspace:', state.workspaceId, 'org:', state.org?.id)
  if (realtimeChannel) supabase.removeChannel(realtimeChannel)

  realtimeChannel = supabase
    .channel(`workspace-${state.workspaceId}`)
    .on('postgres_changes', {
      event: '*',
      schema: 'public',
      table: 'diagram_views',
      filter: `workspace_id=eq.${state.workspaceId}`
    }, (payload) => handleRealtimeChange('diagram_views', payload))
    .on('postgres_changes', {
      event: '*',
      schema: 'public',
      table: 'memory_notes',
      filter: `workspace_id=eq.${state.workspaceId}`
    }, (payload) => handleRealtimeChange('memory_notes', payload))
    .subscribe()

  // Also watch org-level notes if we have an org
  if (state.org?.id) {
    supabase
      .channel(`org-${state.org.id}`)
      .on('postgres_changes', {
        event: '*',
        schema: 'public',
        table: 'org_memory_notes',
        filter: `org_id=eq.${state.org.id}`
      }, (payload) => handleRealtimeChange('org_memory_notes', payload))
      .subscribe()
  }
}

// ── Diagram Mode ─────────────────────────────────────────────────────────────

// ── Action Slot — fixed position between title and diagram ──────────────────
// Same DOM element, same spot. Content swaps, position never changes.
// View mode: proactive question (rose). Edit mode: general prompt (neutral).

const actionSlot = document.getElementById('action-slot')
let actionApplyHandler = null

function removeActionBlock() {
  actionSlot.classList.remove('open')
  actionApplyHandler = null
  // Clear inner after transition
  setTimeout(() => { actionSlot.innerHTML = '' }, 350)
}

function renderActionBlock(question, modeClass, onApply) {
  const placeholder = modeClass === 'mode-edit' ? 'Describe a change...' : 'Add detail...'
  // Short context label shown above the question, so users know what this row is.
  const title = modeClass === 'mode-edit'
    ? 'Edit this tab'
    : 'Improve the diagram'

  actionSlot.innerHTML = `
    <div class="action-slot-inner ${modeClass}">
      <div class="action-slot-label">${title}</div>
      <div class="action-slot-question">${escapeHtml(question)}</div>
      <div class="action-slot-row">
        <input class="action-slot-input" type="text" placeholder="${placeholder}" />
        <button class="action-slot-apply">Apply</button>
      </div>
    </div>
  `

  // Open the slot (smooth max-height transition)
  requestAnimationFrame(() => actionSlot.classList.add('open'))

  const inner = actionSlot.querySelector('.action-slot-inner')
  const input = actionSlot.querySelector('.action-slot-input')
  const applyBtn = actionSlot.querySelector('.action-slot-apply')

  // Typing state — question recedes
  input.addEventListener('input', () => {
    inner.classList.toggle('typing', input.value.trim().length > 0)
  })

  // Apply handler
  actionApplyHandler = async function () {
    const value = input.value.trim()
    console.log('[delma apply] clicked, value:', value, 'hasOnApply:', !!onApply)
    if (!value) return

    // Immediately swap to loading state — hide question/input/button
    actionSlot.innerHTML = `
      <div class="action-slot-loading">
        <span class="loading-dot"></span>
        <span class="loading-dot"></span>
        <span class="loading-dot"></span>
        <span>Updating...</span>
      </div>
    `
    console.log('[delma apply] loading state shown')

    try {
      if (onApply) {
        console.log('[delma apply] calling onApply (proactive question)...')
        await onApply(value, question)
        console.log('[delma apply] onApply done, data saved to Supabase')
      } else {
        console.log('[delma apply] calling applyNaturalLanguageEdit...')
        await applyNaturalLanguageEdit(value)
        console.log('[delma apply] NL edit done — router already persisted to Supabase')

        // Router writes directly to Supabase. DO NOT call saveCurrentTab() —
        // it reads the (stale) editor textarea and would clobber the router's
        // save. Just pause briefly for UX, then refresh to show new content.
        await new Promise(r => setTimeout(r, 600))
      }

      // Both paths land here: hide everything, fetch fresh, show view with flash
      console.log('[delma apply] hiding output, switching to view...')
      removeActionBlock()
      els.diagramOutput.style.transition = 'none'
      els.diagramOutput.style.opacity = '0'
      els.diagramEditor.classList.remove('visible')
      els.diagramOutput.hidden = false

      console.log('[delma apply] fetching fresh data from Supabase...')
      await refreshWorkspace()

      // Now set view mode AFTER fresh data is loaded (so renderWorkspace uses new content)
      state.diagramMode = 'view'
      els.modeToggle.hidden = false
      els.viewModeBtn.hidden = true
      els.editModeBtn.textContent = 'Edit'
      els.editModeBtn.classList.remove('primary')
      els.editModeBtn.classList.add('active')
      console.log('[delma apply] view mode set, rendering fresh content...')

      renderWorkspace()

      requestAnimationFrame(() => {
        els.diagramOutput.style.transition = 'opacity 400ms ease'
        els.diagramOutput.style.opacity = '1'
        flashContentUpdate()
        console.log('[delma apply] view rendered with flash, content visible')
      })
      setWorkspaceStatus('Updated.')
    } catch (err) {
      console.error('[delma apply] error:', err)
      // Restore the prompt on error
      renderActionBlock(question, modeClass, onApply)
      setWorkspaceStatus(`Error: ${err.message}`)
    }
  }

  applyBtn.addEventListener('click', () => actionApplyHandler?.())
  input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') { e.preventDefault(); actionApplyHandler?.() }
  })
}

function setDiagramMode(mode) {
  state.diagramMode = mode
  els.modeToggle.hidden = false
  els.viewModeBtn.hidden = mode !== 'edit'
  els.viewModeBtn.textContent = 'Cancel'
  els.viewModeBtn.classList.remove('active', 'primary')
  els.editModeBtn.textContent = mode === 'edit' ? 'Save' : 'Edit'
  els.editModeBtn.classList.toggle('primary', mode === 'edit')
  els.editModeBtn.classList.toggle('active', mode === 'view')
  els.diagramOutput.hidden = mode === 'edit'
  els.diagramEditor.classList.toggle('visible', mode === 'edit')

  // Render action block for edit mode
  if (mode === 'edit') {
    renderActionBlock('What do you want to update?', 'mode-edit')
  } else {
    removeActionBlock()
  }
}

// ── View Helpers ─────────────────────────────────────────────────────────────

function getActiveView() {
  if (!state.views.length) return defaultViewTemplates()[0]
  return state.views.find(v => v.view_key === state.activeViewKey) || state.views[0] || null
}

// ── Diagram Zoom State ──────────────────────────────────────────────────────

let currentZoom = 1
const ZOOM_MIN = 0.1
const ZOOM_MAX = 2.0
const ZOOM_STEP = 0.15
const SVG_CROP_PADDING = 50

function getDiagramElements() {
  const wrapper = document.querySelector('.diagram-zoom-wrapper')
  const canvas = document.querySelector('.diagram-zoom-canvas')
  const svg = wrapper?.querySelector('svg') || null
  const label = document.querySelector('.zoom-level')
  return { wrapper, canvas, svg, label }
}

function normalizeMermaidForRender(code) {
  return String(code || '').replace(/^---\n[\s\S]*?\n---\n?/, '')
}

function applyDiagramBranding(svg) {
  if (!svg) return

  // Soft border + soft drop shadow on every node — quiet structure, text wins.
  for (const node of svg.querySelectorAll('.node rect, .node polygon')) {
    node.style.filter = 'drop-shadow(0 1px 2px rgba(0, 0, 0, 0.04))'
    node.style.stroke = '#EFE4DE'
    node.style.strokeWidth = '1px'
    node.setAttribute('rx', '10')
    node.setAttribute('ry', '10')
  }

  // Arrows in dark red (kept — only red usage allowed in diagrams).
  for (const edge of svg.querySelectorAll('.edgePath path.path')) {
    edge.style.strokeWidth = '2px'
    edge.style.stroke = '#8F0000'
  }
  for (const marker of svg.querySelectorAll('marker path')) {
    marker.style.fill = '#8F0000'
  }

  // Higher-contrast node text — near-black, slightly heavier weight.
  // EXCLUDE notes — they have their own classDef styling (12px italic).
  for (const label of svg.querySelectorAll('.nodeLabel')) {
    if (label.closest('.node')?.classList.contains('note')) continue
    label.style.fontSize = '14px'
    label.style.fontWeight = '600'
    label.style.color = '#0F0A0A'
    label.style.fill = '#0F0A0A'
  }

  // Fix note clipping: Mermaid sometimes sizes the foreignObject narrower
  // than the actual italic text needs. Stretch the foreignObject to match
  // its container rect so the text isn't truncated mid-word.
  for (const noteNode of svg.querySelectorAll('.node.note')) {
    const containerRect = noteNode.querySelector('rect.basic.label-container')
    const labelG = noteNode.querySelector('g.label')
    const fo = noteNode.querySelector('foreignObject')
    if (!containerRect || !fo || !labelG) continue

    const containerW = parseFloat(containerRect.getAttribute('width') || 0)
    if (!containerW) continue

    const padding = 16   // give the text a little breathing room inside the rect
    const newW = Math.max(containerW - padding, parseFloat(fo.getAttribute('width') || 0))
    fo.setAttribute('width', String(newW))

    // Re-center the label group inside the container
    labelG.setAttribute('transform', `translate(${-newW / 2}, -9)`)

    // Also override any inline max-width on the inner div that might clip
    const innerDiv = fo.querySelector('div')
    if (innerDiv) {
      innerDiv.style.maxWidth = 'none'
      innerDiv.style.width = `${newW}px`
    }
  }
}

/**
 * Measure the bounding union of a list of DOM elements relative to a container rect.
 * Returns { offsetX, offsetY, width, height } or null if no valid rects.
 */
function measureRectUnion(elements, containerRect) {
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity
  for (const el of elements) {
    const r = el.getBoundingClientRect()
    if (!r.width && !r.height) continue
    minX = Math.min(minX, r.left)
    minY = Math.min(minY, r.top)
    maxX = Math.max(maxX, r.right)
    maxY = Math.max(maxY, r.bottom)
  }
  if (!isFinite(minX)) return null
  return {
    offsetX: minX - containerRect.left,
    offsetY: minY - containerRect.top,
    width: maxX - minX,
    height: maxY - minY
  }
}

function getSvgContentBounds(svg) {
  if (!svg?.querySelector) return null

  const svgRect = svg.getBoundingClientRect()
  const existingViewBox = svg.viewBox?.baseVal
  const fallbackBounds = existingViewBox?.width && existingViewBox?.height
    ? {
        x: existingViewBox.x,
        y: existingViewBox.y,
        width: existingViewBox.width,
        height: existingViewBox.height
      }
    : null

  const foreignObjects = [...svg.querySelectorAll('foreignObject')]
    .filter((el) => typeof el.getBoundingClientRect === 'function')

  if (foreignObjects.length && fallbackBounds && svgRect.width && svgRect.height) {
    const union = measureRectUnion(foreignObjects, svgRect)
    if (union?.width && union?.height) {
      const scaleX = fallbackBounds.width / svgRect.width
      const scaleY = fallbackBounds.height / svgRect.height
      return {
        x: fallbackBounds.x + union.offsetX * scaleX - SVG_CROP_PADDING,
        y: fallbackBounds.y + union.offsetY * scaleY - SVG_CROP_PADDING,
        width: union.width * scaleX + SVG_CROP_PADDING * 2,
        height: union.height * scaleY + SVG_CROP_PADDING * 2,
        source: 'foreignObject',
        debug: {
          svgRect: { width: svgRect.width, height: svgRect.height },
          fallbackBounds,
          foreignObjectUnion: union
        }
      }
    }
  }

  const graphRoot =
    svg.querySelector('#graph0') ||
    svg.querySelector('svg > g') ||
    svg.querySelector('g')

  if (!graphRoot?.getBBox) return fallbackBounds

  const box = graphRoot.getBBox()
  if (!box.width || !box.height) {
    return fallbackBounds
  }

  return {
    x: box.x - SVG_CROP_PADDING,
    y: box.y - SVG_CROP_PADDING,
    width: box.width + SVG_CROP_PADDING * 2,
    height: box.height + SVG_CROP_PADDING * 2,
    source: 'graphBBox',
    debug: {
      svgRect: { width: svgRect.width, height: svgRect.height },
      graphBox: { x: box.x, y: box.y, width: box.width, height: box.height },
      fallbackBounds
    }
  }
}

function prepareFittedSvg(svg, wrapper) {
  const bounds = getSvgContentBounds(svg)
  if (!bounds || !wrapper) return null

  svg.setAttribute('viewBox', `${bounds.x} ${bounds.y} ${bounds.width} ${bounds.height}`)
  svg.setAttribute('width', String(bounds.width))
  svg.setAttribute('height', String(bounds.height))
  svg.dataset.baseWidth = String(bounds.width)
  svg.dataset.baseHeight = String(bounds.height)

  return { bounds }
}

function setZoom(level) {
  currentZoom = Math.min(ZOOM_MAX, Math.max(ZOOM_MIN, level))

  const { wrapper, canvas, svg, label } = getDiagramElements()
  if (svg && canvas) {
    const baseWidth = Number(svg.dataset.baseWidth || svg.viewBox.baseVal?.width || 0)
    const baseHeight = Number(svg.dataset.baseHeight || svg.viewBox.baseVal?.height || 0)

    svg.style.transform = `scale(${currentZoom})`
    canvas.style.width = `${Math.max(baseWidth * currentZoom, wrapper?.clientWidth || 0)}px`
    canvas.style.height = `${Math.max(baseHeight * currentZoom, wrapper?.clientHeight || 0)}px`
  }
  if (label) label.textContent = `${Math.round(currentZoom * 100)}%`

  // Also scale the prose text — use CSS zoom so it cascades to nested
  // elements (h2, h3, p, strong, ul) which have their own font-sizes that
  // would otherwise be unaffected by setting font-size on the parent.
  const card = document.querySelector('.diagram-card')
  if (card) {
    for (const prose of card.querySelectorAll('.diagram-prose')) {
      prose.style.zoom = String(currentZoom)
    }
  }
}


function enableDiagramDragging(wrapper) {
  if (!wrapper) return

  let isDragging = false
  let startX = 0
  let startY = 0
  let startScrollLeft = 0
  let startScrollTop = 0

  const stopDragging = () => {
    isDragging = false
    wrapper.classList.remove('dragging')
  }

  wrapper.addEventListener('pointerdown', (event) => {
    if (event.pointerType === 'mouse' && event.button !== 0) return
    if (event.target.closest('.diagram-zoom-controls')) return

    isDragging = true
    startX = event.clientX
    startY = event.clientY
    startScrollLeft = wrapper.scrollLeft
    startScrollTop = wrapper.scrollTop
    wrapper.classList.add('dragging')
    wrapper.setPointerCapture?.(event.pointerId)
  })

  wrapper.addEventListener('pointermove', (event) => {
    if (!isDragging) return
    event.preventDefault()
    wrapper.scrollLeft = startScrollLeft - (event.clientX - startX)
    wrapper.scrollTop = startScrollTop - (event.clientY - startY)
  })

  wrapper.addEventListener('pointerup', stopDragging)
  wrapper.addEventListener('pointercancel', stopDragging)
  wrapper.addEventListener('lostpointercapture', stopDragging)
}

async function renderDiagram(mermaidCode) {
  if (!mermaidCode?.trim()) {
    els.diagramOutput.className = 'diagram-empty'
    els.diagramOutput.textContent = 'This view does not have Mermaid content yet.'
    return true
  }

  // Detect unified format: markdown prose + a ```mermaid fence.
  // We split it into three parts (prose-above, mermaid, prose-below)
  // so we can render the diagram with FULL zoom/drag/pinch support
  // while keeping the prose inline as rich markdown.
  const fenceMatch = mermaidCode.match(/^([\s\S]*?)```mermaid\n([\s\S]*?)\n```([\s\S]*)$/)
  const isMarkdownFormat = /^(?:\s*---\n[\s\S]*?\n---\s*)?\s*(#|```mermaid)/.test(mermaidCode)

  let proseAbove = ''
  let mermaidOnly = mermaidCode
  let proseBelow = ''

  if (fenceMatch) {
    proseAbove = fenceMatch[1].trim()
    mermaidOnly = fenceMatch[2]
    proseBelow = fenceMatch[3].trim()
    console.log('[delma render] split: proseAbove len=' + proseAbove.length + ', mermaid len=' + mermaidOnly.length + ', proseBelow len=' + proseBelow.length)
  } else if (isMarkdownFormat) {
    // Markdown with no mermaid fence — prose only, still in a card
    console.log('[delma render] markdown prose only, no diagram')
    els.diagramOutput.className = ''
    els.diagramOutput.style.opacity = '1'
    els.diagramOutput.innerHTML = `<div class="diagram-card markdown-body"></div>`
    const card = els.diagramOutput.querySelector('.diagram-card')
    await renderMarkdownWithMermaid(card, mermaidCode)
    return true
  } else {
    console.log('[delma render] pure Mermaid (legacy), no prose')
  }

  // Render the Mermaid with full zoom/drag experience.
  // We prepare everything while the container is HIDDEN so the user never
  // sees a half-rendered diagram (no flash of unstyled SVG, no wrong
  // sizing, no jump). Reveal happens only after layout is fully settled.
  try {
    const renderId = `delma-diagram-${Date.now()}`
    const normalizedCode = normalizeMermaidForRender(mermaidOnly)
    console.log('[delma render] preparing diagram (hidden), code len:', normalizedCode.length)
    const t0 = performance.now()
    const { svg } = await mermaid.render(renderId, normalizedCode)
    console.log('[delma render] mermaid.render done in', Math.round(performance.now() - t0), 'ms')

    // Hide the container BEFORE replacing content. Keep its dimensions
    // (visibility:hidden, not display:none) so layout doesn't jump.
    els.diagramOutput.style.visibility = 'hidden'
    els.diagramOutput.style.opacity = '0'
    els.diagramOutput.style.transition = 'none'
    els.diagramOutput.className = ''

    currentZoom = 1
    const aboveHtml = proseAbove ? `<div class="diagram-prose markdown-body above">${marked.parse(proseAbove)}</div>` : ''
    const belowHtml = proseBelow ? `<div class="diagram-prose markdown-body below">${marked.parse(proseBelow)}</div>` : ''

    els.diagramOutput.innerHTML = `
      <div class="diagram-card">
        ${aboveHtml}
        <div class="diagram-zoom-wrapper">
          <div class="diagram-zoom-canvas">${svg}</div>
        </div>
        <div class="diagram-zoom-controls">
          <button class="zoom-btn" data-zoom="in" title="Zoom in">+</button>
          <div class="zoom-level">100%</div>
          <button class="zoom-btn" data-zoom="out" title="Zoom out">&minus;</button>
        </div>
        ${belowHtml}
      </div>
    `

    // Wire everything (zoom buttons, branding, sizing, drag) BEFORE revealing.
    els.diagramOutput.querySelector('[data-zoom="in"]').addEventListener('click', () => setZoom(currentZoom + ZOOM_STEP))
    els.diagramOutput.querySelector('[data-zoom="out"]').addEventListener('click', () => setZoom(currentZoom - ZOOM_STEP))

    const wrapper = els.diagramOutput.querySelector('.diagram-zoom-wrapper')
    const svgEl = wrapper.querySelector('svg')
    applyDiagramBranding(svgEl)
    prepareFittedSvg(svgEl, wrapper)
    enableDiagramDragging(wrapper)

    // Wait for layout to settle BEFORE resolving the promise. This way the
    // outer renderWorkspace().then(reveal) fires only after the diagram is
    // fully prepared — no flashes of unstyled or unsized content.
    console.log('[delma render] waiting two rAFs for layout to settle...')
    await new Promise(resolve => {
      requestAnimationFrame(() => {
        console.log('[delma render] rAF 1 done')
        requestAnimationFrame(() => {
          setZoom(1)
          console.log('[delma render] rAF 2 done — setZoom applied, total prep ms:', Math.round(performance.now() - t0))
          resolve()
        })
      })
    })
    console.log('[delma render] renderDiagram resolving — outer reveal will fire next')
    let lastPinchDist = 0
    wrapper.addEventListener('touchstart', (e) => {
      if (e.touches.length === 2) {
        lastPinchDist = Math.hypot(e.touches[0].clientX - e.touches[1].clientX, e.touches[0].clientY - e.touches[1].clientY)
      }
    }, { passive: true })
    wrapper.addEventListener('touchmove', (e) => {
      if (e.touches.length === 2) {
        const dist = Math.hypot(e.touches[0].clientX - e.touches[1].clientX, e.touches[0].clientY - e.touches[1].clientY)
        const delta = (dist - lastPinchDist) * 0.005
        setZoom(currentZoom + delta)
        lastPinchDist = dist
      }
    }, { passive: true })

    // Scroll-to-zoom with ctrl/cmd
    wrapper.addEventListener('wheel', (e) => {
      if (e.ctrlKey || e.metaKey) {
        e.preventDefault()
        setZoom(currentZoom - e.deltaY * 0.002)
      }
    }, { passive: false })

    return true
  } catch (error) {
    console.error('[delma render] MERMAID ERROR:', error.message, error)
    els.diagramOutput.className = 'diagram-error'
    els.diagramOutput.innerHTML = `<div class="diagram-error-title">Mermaid syntax error</div><pre class="diagram-error-detail">${escapeHtml(error.message)}</pre>`
    return false
  }
}

async function validateCurrentMermaid() {
  const raw = els.diagramEditor.value || els.viewMermaid.value
  if (!raw?.trim()) return true

  // Handle the two storage formats:
  //   1. Markdown with inline ```mermaid fence — validate only the fenced code.
  //      If there's no fence, the doc is prose-only (still valid).
  //   2. Pure Mermaid (legacy) — validate the whole thing.
  const fenceMatch = raw.match(/```mermaid\n([\s\S]*?)\n```/)
  const isMarkdown = /^\s*(#|```mermaid)/.test(raw)

  if (isMarkdown) {
    if (!fenceMatch) {
      console.log('[delma validate] markdown with no mermaid fence — OK')
      return true
    }
    const mermaidCode = normalizeMermaidForRender(fenceMatch[1])
    console.log('[delma validate] extracted mermaid from fence, len:', mermaidCode.length)
    try {
      await mermaid.render(`delma-validate-${Date.now()}`, mermaidCode)
      return true
    } catch (err) {
      console.error('[delma validate] mermaid parse error:', err.message)
      return false
    }
  }

  // Legacy: whole content is Mermaid
  const code = normalizeMermaidForRender(raw)
  try {
    await mermaid.render(`delma-validate-${Date.now()}`, code)
    return true
  } catch (err) {
    console.error('[delma validate] legacy mermaid parse error:', err.message)
    return false
  }
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
  // Order here = order in the tab bar (right of Project High Level diagram tab)
  'decisions.md': { title: 'Project Details', desc: 'Decisions made + actions needed. Outline form.' },
  'environment.md': { title: 'Files Locations and Keys', desc: 'IDs, credentials, DEs, journeys, automations — everything in one place.' }
  // my-notes.md removed — now lives in user_notes table (global per user, not per project)
}

// Org-level tab labels (shared across all projects)
const ORG_TAB_LABELS = {
  'people.md': { title: 'People', desc: 'Team members, roles, ownership. Same across all projects.' },
  'playbook.md': { title: 'General Patterns and Docs', desc: 'How work happens across projects. Processes, approvals, unwritten rules.' }
}

// ── Render ───────────────────────────────────────────────────────────────────

function dotHtml(tabKey) {
  if (!tabsWithUpdates.has(tabKey)) return ''
  return '<span class="tab-update-dot"></span>'
}

function renderViewTabs() {
  els.viewTabs.textContent = ''

  // ── Org-level tabs (shared across all projects) ────────────────────────
  const orgFiles = Object.keys(state.orgMemory).length ? Object.keys(state.orgMemory) : []
  for (const filename of orgFiles) {
    const label = ORG_TAB_LABELS[filename] || { title: filename, desc: '' }
    const row = state.orgMemoryRows.find(r => r.filename === filename)
    const editable = row ? canEditItem(row) : true
    const orgTabKey = `org:${filename}`
    const isActive = state.activeTopTab === 'orgMemory' && state.activeMemoryFile === filename
    const btn = document.createElement('button')
    btn.className = `view-tab${isActive ? ' active' : ''}`
    btn.innerHTML = `<div class="view-tab-title">${editable ? '' : '<span style="opacity:0.4;margin-right:3px;">&#128274;</span>'}${escapeHtml(label.title)}${dotHtml(orgTabKey)}</div>`
    btn.addEventListener('click', () => {
      saveCurrentEditState()
      tabsWithUpdates.delete(orgTabKey)
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

  // Diagram tabs — only when a workspace is loaded (skip in empty org)
  const views = state.workspaceId
    ? (state.views.length ? state.views : defaultViewTemplates())
    : []
  for (const view of views) {
    const btn = document.createElement('button')
    const key = view.view_key
    const editable = canEditItem(view)
    const diaTabKey = `dia:${key}`
    const isActive = state.activeTopTab === 'diagram' && key === state.activeViewKey
    btn.className = `view-tab${isActive ? ' active' : ''}`
    btn.innerHTML = `<div class="view-tab-title">${editable ? '' : '<span style="opacity:0.4;margin-right:3px;">&#128274;</span>'}${escapeHtml(view.title)}${dotHtml(diaTabKey)}</div>`
    btn.addEventListener('click', () => {
      saveCurrentEditState()
      tabsWithUpdates.delete(diaTabKey)
      state.activeTopTab = 'diagram'
      state.activeViewKey = key
      state.previewMermaid = view.mermaid || ''
      renderWorkspace()
    })
    els.viewTabs.appendChild(btn)
  }

  // Project memory tabs — only render if a project is actually loaded.
  // Iterate in MEMORY_TAB_LABELS order (decisions → environment).
  // Filter out my-notes.md (now lives globally in user_notes table).
  const knownOrder = Object.keys(MEMORY_TAB_LABELS)
  const presentFiles = Object.keys(state.memory).filter(f => f !== 'my-notes.md')
  const hasProject = !!state.workspaceId
  const orderedKnown = hasProject ? knownOrder.filter(f => presentFiles.includes(f) || presentFiles.length === 0) : []
  const extras = presentFiles.filter(f => !knownOrder.includes(f))
  const memFiles = [...orderedKnown, ...extras]
  for (const filename of memFiles) {
    const label = MEMORY_TAB_LABELS[filename] || { title: filename, desc: '' }
    const row = state.memoryRows.find(r => r.filename === filename)
    const editable = row ? canEditItem(row) : true
    const memTabKey = `mem:${filename}`
    const isActive = state.activeTopTab === 'memory' && state.activeMemoryFile === filename
    const btn = document.createElement('button')
    btn.className = `view-tab${isActive ? ' active' : ''}`
    btn.innerHTML = `<div class="view-tab-title">${editable ? '' : '<span style="opacity:0.4;margin-right:3px;">&#128274;</span>'}${escapeHtml(label.title)}${dotHtml(memTabKey)}</div>`
    btn.addEventListener('click', () => {
      saveCurrentEditState()
      tabsWithUpdates.delete(memTabKey)
      state.activeTopTab = 'memory'
      state.activeMemoryFile = filename
      renderWorkspace()
    })
    els.viewTabs.appendChild(btn)
  }

  // ── Global My Notes — separator + tab on the far right ─────────────
  if (state.user) {
    const sep2 = document.createElement('span')
    sep2.style.cssText = 'width:1px;height:20px;background:rgba(0,0,0,0.12);flex-shrink:0;'
    els.viewTabs.appendChild(sep2)

    const isActive = state.activeTopTab === 'myNotes'
    const btn = document.createElement('button')
    btn.className = `view-tab${isActive ? ' active' : ''}`
    btn.innerHTML = `<div class="view-tab-title">My Notes</div>`
    btn.addEventListener('click', () => {
      saveCurrentEditState()
      state.activeTopTab = 'myNotes'
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

// Render the global My Notes (per-user). Stored in user_notes table —
// follows the user across all orgs and projects.
async function renderGlobalMyNotes() {
  els.viewTitle.textContent = 'My Notes'
  els.viewDescription.textContent = 'Personal scratchpad — only you see this. Follows you across all orgs and projects.'
  els.viewProvenance.textContent = ''
  els.resetExampleBtn.hidden = true
  els.modeToggle.hidden = false

  if (state.globalNotesUnavailable) {
    els.diagramOutput.hidden = false
    els.diagramEditor.classList.remove('visible')
    els.diagramOutput.className = ''
    els.diagramOutput.innerHTML = `
      <div class="diagram-card markdown-body">
        <p>Your notes table isn't ready yet. Run the migration in your Supabase SQL editor to enable My Notes:</p>
        <pre>supabase/migrations/006_user_notes.sql</pre>
      </div>
    `
    return
  }

  const content = state.globalNotes || ''
  if (state.diagramMode === 'edit') {
    els.diagramOutput.hidden = true
    els.diagramEditor.classList.add('visible')
    els.diagramEditor.value = content
    setDiagramMode('edit')
  } else {
    els.diagramOutput.hidden = false
    els.diagramEditor.classList.remove('visible')
    els.diagramOutput.className = ''
    els.diagramOutput.innerHTML = `<div class="diagram-card markdown-body"><div class="markdown-content"></div></div>`
    const card = els.diagramOutput.querySelector('.diagram-card')
    const contentEl = card.querySelector('.markdown-content')
    await renderMarkdownWithMermaid(contentEl, content.trim() || '_(empty — click Edit to add notes)_')
    setDiagramMode('view')
  }
}

async function renderMemoryDocument(filename, isOrg = false) {
  const content = isOrg ? (state.orgMemory[filename] || '') : (state.memory[filename] || '')
  const label = (isOrg ? ORG_TAB_LABELS[filename] : MEMORY_TAB_LABELS[filename]) || { title: filename, desc: '' }
  const row = isOrg
    ? state.orgMemoryRows.find(r => r.filename === filename)
    : state.memoryRows.find(r => r.filename === filename)
  const editable = row ? canEditItem(row) : true

  els.viewTitle.textContent = label.title
  els.viewDescription.textContent = label.desc
  els.viewProvenance.textContent = row?.updated_at
    ? `Last saved ${timeAgo(row.updated_at)}`
    : ''
  els.resetExampleBtn.hidden = true

  // Hide Edit button if user can't edit this tab
  els.modeToggle.hidden = !editable
  if (!editable && state.diagramMode === 'edit') state.diagramMode = 'view'
  if (!els.modeToggle.hidden) setDiagramMode(state.diagramMode)

  if (state.diagramMode === 'edit' && editable) {
    // Structured tabs get a form editor backed by typed ops. Raw markdown
    // editing for these tabs is gone — it was the source of silent data loss
    // (manual saves overwriting structured JSON).
    if (isStructuredTab(filename)) {
      els.diagramEditor.classList.remove('visible')
      els.diagramOutput.hidden = false
      els.diagramOutput.className = ''
      els.diagramOutput.innerHTML = `<div class="diagram-card"><div class="struct-host"></div></div>`
      const host = els.diagramOutput.querySelector('.struct-host')
      const tabKey = `${isOrg ? 'org' : 'memory'}:${filename}`
      const took = renderStructuredEditor(host, {
        filename,
        structured: row?.structured,
        tabKey,
        ctx: { workspaceId: state.workspaceId, orgId: state.org?.id },
        authHeaders,
        onAfter: () => triggerClaudeMdRefresh()
      })
      if (took) return
    }
    els.diagramOutput.hidden = true
    els.diagramEditor.classList.add('visible')
    els.diagramEditor.value = content
  } else {
    els.diagramOutput.hidden = false
    els.diagramEditor.classList.remove('visible')
    console.log('[delma render] view mode markdown, file:', filename, 'contentLen:', content.length, 'first60:', content.substring(0, 60))
    // Wrap markdown in a .diagram-card so every tab matches Architecture's
    // visual treatment (white card on cream, dark red border).
    els.diagramOutput.className = ''
    els.diagramOutput.innerHTML = `
      <div class="diagram-card markdown-body">
        <div class="markdown-content"></div>
        <div class="diagram-zoom-controls" hidden>
          <button class="zoom-btn" data-zoom="in" title="Zoom in">+</button>
          <div class="zoom-level">100%</div>
          <button class="zoom-btn" data-zoom="out" title="Zoom out">&minus;</button>
        </div>
      </div>
    `
    const card = els.diagramOutput.querySelector('.diagram-card')
    const contentEl = card.querySelector('.markdown-content')
    await renderMarkdownWithMermaid(contentEl, content.trim() || '*(empty)*')

    // Wire zoom controls — every markdown tab gets them (text scales too).
    const zoomCtrl = card.querySelector('.diagram-zoom-controls')
    if (zoomCtrl) {
      zoomCtrl.hidden = false
      zoomCtrl.querySelector('[data-zoom="in"]').addEventListener('click', () => setInlineZoom(card, currentInlineZoom + ZOOM_STEP))
      zoomCtrl.querySelector('[data-zoom="out"]').addEventListener('click', () => setInlineZoom(card, currentInlineZoom - ZOOM_STEP))
      currentInlineZoom = 1
      const svgs = card.querySelectorAll('.mermaid-inline svg').length
      console.log('[delma render] zoom controls wired —', svgs, 'inline mermaid svg(s) + prose')
    }

  }
}

// Zoom for markdown tabs (People, Playbook). Scales EVERYTHING in the
// content area — text, headings, tables, lists, AND inline Mermaid SVGs —
// via CSS `zoom` on the .markdown-content wrapper. Zoom controls live
// outside the wrapper so they don't scale themselves.
let currentInlineZoom = 1
function setInlineZoom(card, level) {
  currentInlineZoom = Math.min(ZOOM_MAX, Math.max(ZOOM_MIN, level))
  const content = card.querySelector('.markdown-content')
  if (content) {
    // CSS zoom scales text, images, SVGs, and reflows layout naturally.
    // Wider than transform: scale because layout box adjusts.
    content.style.zoom = String(currentInlineZoom)
  }
  const label = card.querySelector('.diagram-zoom-controls .zoom-level')
  if (label) label.textContent = `${Math.round(currentInlineZoom * 100)}%`
  console.log('[delma inline-zoom] set to', currentInlineZoom.toFixed(2), '— scales text + diagrams together')
}

// ── Render the overview tab (diagrams + memory summary) ─────────────────────

// ── Main renderWorkspace ────────────────────────────────────────────────────

// Hide diagramOutput before any render so users never see partial states.
// Caller must invoke revealDiagramOutput() after rendering completes.
let __renderSeq = 0
function hideDiagramOutput() {
  __renderSeq += 1
  console.log(`[delma reveal] HIDE #${__renderSeq} — visibility:hidden, opacity:0`)
  els.diagramOutput.style.transition = 'none'
  els.diagramOutput.style.opacity = '0'
  els.diagramOutput.style.visibility = 'hidden'
}

function revealDiagramOutput() {
  const seq = __renderSeq
  console.log(`[delma reveal] REVEAL queued for #${seq}`)
  // Two rAFs ensure the new layout has settled before we fade in.
  requestAnimationFrame(() => {
    requestAnimationFrame(() => {
      els.diagramOutput.style.visibility = 'visible'
      els.diagramOutput.style.transition = 'opacity 200ms ease'
      els.diagramOutput.style.opacity = '1'
      console.log(`[delma reveal] REVEAL fired for #${seq} — opacity:1`)
    })
  })
}

function renderWorkspace() {
  renderViewTabs()

  // Hide before ANY render so we never see the old content swap to new.
  hideDiagramOutput()

  // Global My Notes (per-user, follows across orgs/projects)
  if (state.activeTopTab === 'myNotes') {
    void renderGlobalMyNotes().then(revealDiagramOutput)
    return
  }

  // Org memory tab (People, Playbook)
  if (state.activeTopTab === 'orgMemory') {
    void renderMemoryDocument(state.activeMemoryFile, true).then(revealDiagramOutput)
    return
  }

  // Project memory tab
  if (state.activeTopTab === 'memory') {
    void renderMemoryDocument(state.activeMemoryFile).then(revealDiagramOutput)
    return
  }

  // Diagram tab
  // Empty-org case: no workspace, show prominent CTA to create the first project
  if (!state.workspaceId) {
    els.viewTitle.textContent = `Welcome to ${state.org?.name || 'your workspace'}`
    els.viewDescription.textContent = 'No projects yet. Get started by creating one.'
    els.viewProvenance.textContent = ''
    els.modeToggle.hidden = true
    els.diagramOutput.className = ''
    els.diagramOutput.innerHTML = `
      <div class="diagram-card empty-state">
        <div class="empty-state-icon">📁</div>
        <div class="empty-state-title">Create your first project</div>
        <div class="empty-state-sub">Projects hold your architecture, decisions, and configuration.<br/>Each project is its own workspace.</div>
        <button id="empty-create-project-btn" class="empty-state-cta">+ Create project</button>
      </div>
    `
    const btn = document.getElementById('empty-create-project-btn')
    if (btn) btn.addEventListener('click', () => showInlineCreateProject(btn))
    revealDiagramOutput()
    return
  }
  const view = getActiveView()
  if (!view) {
    els.diagramOutput.className = 'documentation-shell'
    els.diagramOutput.textContent = 'No view loaded.'
    revealDiagramOutput()
    return
  }

  const editable = canEditItem(view)

  els.modeToggle.hidden = !editable
  els.resetExampleBtn.hidden = !editable
  if (!editable && state.diagramMode === 'edit') state.diagramMode = 'view'

  els.viewTitle.textContent = view.title
  els.viewDescription.textContent = view.description || ''
  els.viewProvenance.textContent = view.updated_at
    ? `Last saved ${timeAgo(view.updated_at)}`
    : ''
  populateEditor(view)
  setDiagramMode(state.diagramMode)

  if (state.diagramMode !== 'edit') {
    const mermaidCode = state.previewMermaid || view.mermaid || ''
    console.log('[delma render] view mode render, mermaidLen:', mermaidCode.length, 'first60:', mermaidCode.substring(0, 60))
    els.diagramOutput.className = ''
    // renderDiagram handles its own internal hide/reveal cycle.
    void renderDiagram(mermaidCode).then(revealDiagramOutput)
  } else {
    // Edit mode — show the textarea immediately
    revealDiagramOutput()
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

function discardCurrentEditState() {
  if (state.activeTopTab === 'orgMemory') {
    els.diagramEditor.value = state.orgMemory[state.activeMemoryFile] || ''
    return
  }

  if (state.activeTopTab === 'memory') {
    els.diagramEditor.value = state.memory[state.activeMemoryFile] || ''
    return
  }

  const view = getActiveView()
  if (!view) return
  state.previewMermaid = view.mermaid || ''
  populateEditor(view)
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

// Fire-and-forget refresh of CLAUDE.md so the next message Claude Code
// sends will see the latest workspace state via the UserPromptSubmit hook.
function triggerClaudeMdRefresh() {
  if (!state.workspaceId) return
  fetch('/api/refresh-claude-md', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ workspaceId: state.workspaceId })
  }).then(r => r.json()).then(data => {
    console.log('[delma claude-md] refreshed:', data.length, 'chars in', data.ms, 'ms')
  }).catch(err => console.error('[delma claude-md] refresh failed:', err))
}

async function saveCurrentTab() {
  // Global My Notes (no workspace required — follows the user)
  if (state.activeTopTab === 'myNotes') {
    console.log('[delma save] saving global my notes')
    await saveGlobalNotes(els.diagramEditor.value)
    setWorkspaceStatus('Notes saved.')
    return
  }
  if (!state.workspaceId) return
  console.log('[delma save] saving tab:', state.activeTopTab, state.activeMemoryFile || state.activeViewKey)

  // Reset dismissed flag + start grace window for this tab
  noteTabChanged(getCurrentTabKey())

  // Save org-level memory tab
  if (state.activeTopTab === 'orgMemory') {
    const filename = state.activeMemoryFile
    const content = els.diagramEditor.value
    state.orgMemory[filename] = content

    if (isStructuredTab(filename)) {
      // Structured tabs: route through /api/save-structured-tab so the server
      // re-parses the markdown into JSON. Without this, manual edits would be
      // overwritten the next time the typed-op router touches the tab.
      await postStructuredSave(`org:${filename}`, content)
    } else {
      const { data: existing } = await supabase
        .from('org_memory_notes').select('id')
        .eq('org_id', state.org.id).eq('filename', filename).single()
      if (existing) {
        await supabase.from('org_memory_notes').update({ content }).eq('id', existing.id)
      } else {
        await supabase.from('org_memory_notes').insert({
          org_id: state.org.id, filename, content, permission: 'edit-all', owner_id: state.user.id
        })
      }
    }

    await refreshWorkspace()
    setWorkspaceStatus(`Saved ${ORG_TAB_LABELS[filename]?.title || filename}.`)
    return
  }

  // Save project-level memory tab
  if (state.activeTopTab === 'memory') {
    const filename = state.activeMemoryFile
    const content = els.diagramEditor.value
    state.memory[filename] = content

    if (isStructuredTab(filename)) {
      await postStructuredSave(`memory:${filename}`, content)
    } else {
      const { data: existing } = await supabase
        .from('memory_notes').select('id')
        .eq('workspace_id', state.workspaceId).eq('filename', filename)
        .or(`visibility.eq.shared,owner_id.eq.${state.user.id}`).single()
      if (existing) {
        await supabase.from('memory_notes').update({ content }).eq('id', existing.id)
      } else {
        await supabase.from('memory_notes').insert({
          workspace_id: state.workspaceId, filename, content, visibility: 'shared', owner_id: state.user.id
        })
      }
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

  // Refresh CLAUDE.md so Claude Code sees the change on its next message.
  triggerClaudeMdRefresh()
}

// ── Custom Branded Dropdown — used for both Org and Project selectors ───────
//
// Replaces native <select> so the open panel matches our cream/white/red
// brand instead of the OS-native chrome. Last item is "+ New …" which
// transforms the trigger into an inline input.

const orgSelector = document.getElementById('org-selector')
const projectSelector = document.getElementById('project-selector')

// Track which dropdown is currently open so click-outside closes it
let __openDropdown = null
document.addEventListener('click', (e) => {
  if (__openDropdown && !__openDropdown.contains(e.target)) {
    __openDropdown.classList.remove('open')
    __openDropdown = null
  }
})

// Render a branded dropdown into `container`. Items: [{id, label}], plus
// optional "+ New" handler that opens an inline input.
function renderBrandDropdown(container, { items, activeId, placeholder, onSelect, newLabel, onCreate }) {
  if (!container) return  // org/project selectors removed from UI — one workspace per user
  container.innerHTML = ''
  const active = items.find(i => i.id === activeId) || items[0]
  const triggerLabel = active?.label || placeholder || '—'

  const trigger = document.createElement('button')
  trigger.type = 'button'
  trigger.className = 'brand-dropdown-trigger'
  trigger.innerHTML = `<span class="brand-dropdown-label">${escapeHtml(triggerLabel)}</span>`
  container.appendChild(trigger)

  const panel = document.createElement('div')
  panel.className = 'brand-dropdown-panel'
  container.appendChild(panel)

  for (const item of items) {
    const opt = document.createElement('button')
    opt.type = 'button'
    opt.className = `brand-dropdown-item${item.id === activeId ? ' active' : ''}`
    opt.textContent = item.label
    opt.addEventListener('click', (e) => {
      e.stopPropagation()
      container.classList.remove('open')
      __openDropdown = null
      onSelect(item.id)
    })
    panel.appendChild(opt)
  }

  if (onCreate) {
    const newOpt = document.createElement('button')
    newOpt.type = 'button'
    newOpt.className = 'brand-dropdown-item new'
    newOpt.textContent = newLabel || '+ New…'
    newOpt.addEventListener('click', (e) => {
      e.stopPropagation()
      // Replace panel content with an inline input
      panel.innerHTML = ''
      const input = document.createElement('input')
      input.type = 'text'
      input.className = 'brand-dropdown-input'
      input.placeholder = 'Name'
      panel.appendChild(input)
      input.focus()

      const submit = async () => {
        const name = input.value.trim()
        if (!name) { container.classList.remove('open'); __openDropdown = null; return }
        input.disabled = true
        try {
          await onCreate(name)
        } catch (err) {
          setWorkspaceStatus(err.message)
        }
        container.classList.remove('open')
        __openDropdown = null
      }
      input.addEventListener('keydown', (ev) => {
        ev.stopPropagation()
        if (ev.key === 'Enter') { ev.preventDefault(); submit() }
        if (ev.key === 'Escape') { container.classList.remove('open'); __openDropdown = null }
      })
    })
    panel.appendChild(newOpt)
  }

  trigger.addEventListener('click', (e) => {
    e.stopPropagation()
    if (container.classList.contains('open')) {
      container.classList.remove('open')
      __openDropdown = null
    } else {
      if (__openDropdown) __openDropdown.classList.remove('open')
      container.classList.add('open')
      __openDropdown = container
    }
  })
}

function renderOrgSelector() {
  renderBrandDropdown(orgSelector, {
    items: state.orgs.map(o => ({ id: o.id, label: o.name })),
    activeId: state.org?.id,
    placeholder: 'No organizations',
    newLabel: '+ New organization…',
    onSelect: async (orgId) => {
      console.log('[delma org] switching to', orgId)
      state.org = state.orgs.find(o => o.id === orgId) || null
      state.orgMemory = {}
      state.orgMemoryRows = []
      await loadWorkspaces()
      console.log('[delma org] switched, workspaces:', state.workspaces.length)
      renderOrgSelector()        // refresh active highlight
      renderProjectSelector()
      if (state.workspaces.length) {
        await openWorkspace(state.workspaces[0].id)
      } else {
        // No projects yet — clear state and show an empty card
        state.workspaceId = null
        state.views = []
        state.memoryRows = []
        state.memory = {}
        if (els.viewTitle) els.viewTitle.textContent = state.org?.name || ''
        if (els.viewDescription) els.viewDescription.textContent = 'No projects yet. Use the project dropdown to create one.'
        if (els.viewProvenance) els.viewProvenance.textContent = ''
        renderWorkspace()
        setWorkspaceStatus(`Switched to ${state.org?.name}. Add a project to get started.`)
      }
    },
    onCreate: async (name) => {
      console.log('[delma org] creating new org via server:', name)
      const res = await fetch('/api/create-org', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name, userId: state.user.id })
      })
      const data = await res.json()
      if (!res.ok) {
        console.error('[delma org] create failed:', data)
        alert(`Couldn't create organization: ${data.error}`)
        throw new Error(data.error)
      }
      console.log('[delma org] created:', data.org)
      state.orgs.push({ ...data.org, orgRole: 'admin' })
      state.org = state.orgs[state.orgs.length - 1]
      state.workspaces = []
      state.workspaceId = null
      renderOrgSelector()
      renderProjectSelector()
      renderWorkspace()
      setWorkspaceStatus(`Created organization "${name}". Add a project to get started.`)
    }
  })
}

function renderProjectSelector() {
  renderBrandDropdown(projectSelector, {
    items: state.workspaces.map(w => ({ id: w.id, label: w.name })),
    activeId: state.workspaceId,
    placeholder: 'No projects',
    newLabel: '+ New project…',
    onSelect: async (wsId) => { await openWorkspace(wsId) },
    onCreate: createProjectFromName
  })
}

// Reusable project creation — used by the dropdown AND the empty-state CTA.
async function createProjectFromName(name) {
  const ws = await createWorkspace(name)
  state.workspaces.push({ ...ws, role: 'owner' })
  renderProjectSelector()
  await openWorkspace(ws.id)
  setWorkspaceStatus(`Created "${ws.name}".`)
}

// Inline name input shown in the empty-state CTA. Replaces the button with
// a prompt-style input the user types into.
function showInlineCreateProject(originalBtn) {
  const wrap = originalBtn.parentElement
  const input = document.createElement('input')
  input.type = 'text'
  input.className = 'empty-state-input'
  input.placeholder = 'Project name (e.g. Birthday Campaign)'
  originalBtn.replaceWith(input)
  input.focus()

  const submit = async () => {
    const name = input.value.trim()
    if (!name) return
    input.disabled = true
    try {
      await createProjectFromName(name)
    } catch (err) {
      setWorkspaceStatus(err.message)
      input.disabled = false
    }
  }
  input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') { e.preventDefault(); submit() }
    if (e.key === 'Escape') {
      input.replaceWith(originalBtn)
      originalBtn.addEventListener('click', () => showInlineCreateProject(originalBtn), { once: true })
    }
  })
}

// (Selection + create handlers now live inside renderBrandDropdown calls
//  in renderOrgSelector / renderProjectSelector — no separate change events.)

// ── Natural Language Edit ─────────────────────────────────────────────────────
// User describes a change in plain English. DeepSeek rewrites the content.

/**
 * Briefly highlight a range of lines in the textarea editor.
 * Uses an absolute-positioned overlay with warm rose tint.
 * Fades out after 3 seconds. Shows the user exactly what changed.
 */
function highlightEditorLines(firstLine, lastLine) {
  const editor = els.diagramEditor
  if (!editor) return

  // Calculate pixel positions from line numbers
  const lineHeight = parseFloat(getComputedStyle(editor).lineHeight) || 18
  const paddingTop = parseFloat(getComputedStyle(editor).paddingTop) || 14

  const top = paddingTop + (firstLine * lineHeight)
  const height = ((lastLine - firstLine + 1) * lineHeight)

  // Need a positioned parent
  const parent = editor.parentElement
  if (getComputedStyle(parent).position === 'static') parent.style.position = 'relative'

  // Remove any existing highlight
  parent.querySelectorAll('.editor-highlight-overlay').forEach(el => el.remove())

  const overlay = document.createElement('div')
  overlay.className = 'editor-highlight-overlay'
  overlay.style.top = `${top}px`
  overlay.style.height = `${height}px`
  parent.appendChild(overlay)

  // Scroll editor to show the changed region
  editor.scrollTop = Math.max(0, top - 40)

  // Fade out after 3 seconds
  setTimeout(() => overlay.classList.add('fading'), 100)
  setTimeout(() => overlay.remove(), 3500)
}

// ── Unified fact router — sees all tabs, updates the right one(s) ──────────
// Works for both proactive-question answers and manual NL edits.
// One LLM call that:
//   1. Sees all tabs (diagrams + project memory + org memory)
//   2. Decides which tab(s) the user's input belongs on
//   3. Returns JSON patches scoped to those tabs
// Applies patches to Supabase, returns list of affected tab keys.

async function routeAndPatchFact(input, questionContext = null) {
  console.log('[delma router] starting, input:', input.substring(0, 80), 'questionCtx:', questionContext?.substring(0, 40))
  const t0 = performance.now()

  // Build snapshot of all tabs with their content + metadata
  const tabs = []

  // Diagrams — stored as markdown-with-inline-mermaid
  for (const v of state.views) {
    if (!v.mermaid) continue
    tabs.push({
      key: `diagram:${v.view_key}`,
      type: 'markdown-with-mermaid',
      title: v.title,
      scope: 'Architecture document — plain-english prose explaining how the system works, PLUS an inline Mermaid diagram in a ```mermaid fence. Scope: automations, DEs, SQL, journeys, emails, cloudpages, decision splits. NOT people or roles.',
      content: v.mermaid,
      id: v.id,
      table: 'diagram_views'
    })
  }

  // Project memory — include structured JSON when present so the LLM can
  // output precise ops rather than guess at shape.
  for (const row of state.memoryRows) {
    if (!row.content && !row.structured) continue
    tabs.push({
      key: `memory:${row.filename}`,
      title: MEMORY_TAB_LABELS[row.filename]?.title || row.filename,
      content: row.content,
      structured: row.structured || null,
      filename: row.filename
    })
  }

  // Org memory
  for (const row of state.orgMemoryRows) {
    if (!row.content && !row.structured) continue
    tabs.push({
      key: `org:${row.filename}`,
      title: ORG_TAB_LABELS[row.filename]?.title || row.filename,
      content: row.content,
      structured: row.structured || null,
      filename: row.filename
    })
  }

  console.log('[delma router] tabs available:', tabs.map(t => t.key).join(', '))

  const tabsBlock = buildTabsBlock(tabs)
  const userMessage = buildRouterUserMessage(input, tabsBlock, questionContext)

  try {
    const res = await fetch('/api/chat', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Delma-Caller': 'router', ...(await authHeaders()) },
      body: JSON.stringify({
        model: 'claude-haiku-4-5',
        max_tokens: 2000,
        system: ROUTER_SYSTEM_PROMPT,
        user: userMessage,
        // Logged server-side as the input that produced these ops:
        meta: { input, workspace_id: state.workspaceId }
      })
    })

    console.log('[delma router] response status:', res.status, 'in', Math.round(performance.now() - t0), 'ms')
    if (!res.ok) {
      const err = await res.json().catch(() => ({}))
      console.error('[delma router] error:', err)
      return { updatedTabs: [] }
    }

    const data = await res.json()
    let raw = data.content?.[0]?.text?.trim()
    console.log('[delma router] raw response:', raw?.substring(0, 300))
    if (!raw) return { updatedTabs: [] }

    const ops = extractJsonArray(raw)
    console.log('[delma router] parsed', ops.length, 'op(s):', ops.map(o => `${o.tab}/${o.op}`).join(', '))

    if (!Array.isArray(ops) || !ops.length) {
      console.log('[delma router] no ops (empty array)')
      return { updatedTabs: [] }
    }

    // Group ops by tab so we can POST once per tab.
    const opsByTab = {}
    for (const o of ops) {
      if (!o.tab || !o.op) continue
      if (!opsByTab[o.tab]) opsByTab[o.tab] = []
      opsByTab[o.tab].push({ op: o.op, args: o.args || {} })
    }

    const updatedTabs = []
    for (const [tabKey, tabOps] of Object.entries(opsByTab)) {
      console.log('[delma router] POST /api/op', tabKey, tabOps.length, 'op(s)')
      const headers = { 'Content-Type': 'application/json', ...(await authHeaders()) }
      const res = await fetch('/api/op', {
        method: 'POST',
        headers,
        body: JSON.stringify({
          tabKey, ops: tabOps,
          workspaceId: state.workspaceId,
          orgId: state.org?.id
        })
      })
      if (!res.ok) {
        const err = await res.json().catch(() => ({}))
        console.error('[delma router] op failed for', tabKey, err)
        continue
      }
      const result = await res.json()
      if (result.errors?.length) console.warn('[delma router] partial errors for', tabKey, result.errors)
      const title = tabs.find(t => t.key === tabKey)?.title || tabKey
      updatedTabs.push({ key: tabKey, title })
      noteTabChanged(tabKey)
    }

    console.log('[delma router] done in', Math.round(performance.now() - t0), 'ms, updated', updatedTabs.length, 'tab(s)')
    if (updatedTabs.length) triggerClaudeMdRefresh()
    return { updatedTabs }
  } catch (err) {
    console.error('[delma router] fetch error:', err)
    return { updatedTabs: [] }
  }
}

async function applyNaturalLanguageEdit(instruction) {
  if (!instruction?.trim()) return
  console.log('[delma edit] routing through unified fact router')
  const { updatedTabs } = await routeAndPatchFact(instruction)
  if (!updatedTabs.length) {
    setWorkspaceStatus('Noted — nothing matched a tab.')
    return
  }
  const names = updatedTabs.map(t => t.title).join(', ')
  setWorkspaceStatus(`Updated: ${names}`)
}

// ── Event Listeners ──────────────────────────────────────────────────────────

els.viewModeBtn.addEventListener('click', () => {
  discardCurrentEditState()
  setDiagramMode('view')
  renderWorkspace()
  setWorkspaceStatus('Changes discarded.')
})

els.editModeBtn.addEventListener('click', () => {
  console.log('[delma save-btn] clicked, mode:', state.diagramMode, 'tab:', state.activeTopTab)
  if (state.diagramMode === 'edit') {
    // Immediate visual feedback so the user knows the click registered.
    const btn = els.editModeBtn
    const originalLabel = btn.textContent
    btn.disabled = true
    btn.classList.add('saving')
    btn.innerHTML = '<span class="apply-spinner"></span><span style="margin-left:8px">Saving...</span>'
    if (els.viewModeBtn) els.viewModeBtn.disabled = true
    console.log('[delma save-btn] showing saving state')

    void (async () => {
      if (state.activeTopTab === 'diagram') {
        console.log('[delma save-btn] validating diagram content...')
        const valid = await validateCurrentMermaid()
        console.log('[delma save-btn] validation result:', valid)
        if (!valid) {
          updateActiveViewFromEditor()
          // Restore the button state on validation failure
          btn.disabled = false
          btn.classList.remove('saving')
          btn.textContent = originalLabel
          if (els.viewModeBtn) els.viewModeBtn.disabled = false
          renderWorkspace()
          setWorkspaceStatus('Fix the Mermaid syntax error before saving.')
          return
        }
      }

      console.log('[delma save-btn] calling saveCurrentTab...')
      await saveCurrentTab()
      console.log('[delma save-btn] save done, switching to view')

      // Brief "Saved ✓" flash before switching to view mode
      btn.classList.remove('saving')
      btn.classList.add('saved')
      btn.innerHTML = '<span style="font-size:14px">✓</span><span style="margin-left:6px">Saved</span>'
      await new Promise(r => setTimeout(r, 600))

      btn.disabled = false
      btn.classList.remove('saved')
      btn.textContent = 'Edit'
      if (els.viewModeBtn) els.viewModeBtn.disabled = false
      setDiagramMode('view')
      renderWorkspace()
    })().catch(err => {
      console.error('[delma save-btn] error:', err)
      btn.disabled = false
      btn.classList.remove('saving', 'saved')
      btn.textContent = originalLabel
      if (els.viewModeBtn) els.viewModeBtn.disabled = false
      setWorkspaceStatus(err.message)
      appendLog('Save Failed', err.message, 'error')
    })
    return
  }

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
  console.log('[delma init] starting...')
  els.sdkStatus.textContent = 'Checking auth...'
  els.connectBtn.textContent = 'Open Workspace'
  els.input.disabled = true
  els.sendBtn.disabled = true

  if (els.authCopy) els.authCopy.textContent = 'Sign in with your email and password.'
  if (els.authUsername) els.authUsername.placeholder = 'Email'
  if (els.projectDir) els.projectDir.placeholder = 'Workspace name'

  // Skip the template render — wait for real workspace data so the user
  // never sees a placeholder diagram flash before the actual content.
  hideDiagramOutput()
  console.log('[delma init] diagramOutput hidden until real data loads')

  const user = await checkAuth()

  if (user) {
    console.log('[delma init] loading orgs and workspaces...')
    await loadOrgs()
    await loadWorkspaces()
    console.log('[delma init] orgs:', state.orgs.length, 'workspaces:', state.workspaces.length)
    renderOrgSelector()
    renderProjectSelector()

    if (state.workspaces.length) {
      console.log('[delma init] opening first workspace:', state.workspaces[0].name)
      await openWorkspace(state.workspaces[0].id)
    } else {
      console.log('[delma init] no workspaces found')
      setWorkspaceStatus('Create a project to get started.')
      // No workspace — render the empty default and reveal
      renderWorkspace()
    }
  } else {
    // Not logged in — render placeholder and reveal so auth UI is visible
    renderWorkspace()
  }
  console.log('[delma init] complete')
}

// ── Proactive Prompt Engine ──────────────────────────────────────────────────
//
// Every 5 minutes, reads the current tab content and asks DeepSeek if
// anything is obviously missing. If yes, shows one quiet inline prompt
// below the title. The user can answer (content appends to the tab),
// or dismiss with X (gone for this tab this session).
//
// Rules:
//   - One question at a time. Never stack.
//   - Only appears when the screen is calm (no typing/scrolling for 3s).
//   - Dismissed tabs are remembered for the session.
//   - No history, no trace. Just a better document.

const dismissedTabs = new Set()
// When a tab's content changes, we clear its dismissed flag AND record the
// change time so we don't fire a gap question instantly — the user deserves
// a grace window to see their own edit first.
const tabChangedAt = new Map() // tabKey -> timestamp
const TAB_CHANGE_GRACE_MS = 60 * 1000
let promptTimer = null
let idleTimer = null
let lastActivity = Date.now()

// Called whenever a tab's content changes (router, realtime, manual save).
// Clears the dismissed flag so a fresh gap question can fire after grace.
function noteTabChanged(tabKey) {
  if (!tabKey) return
  const wasDismissed = dismissedTabs.has(tabKey)
  dismissedTabs.delete(tabKey)
  tabChangedAt.set(tabKey, Date.now())
  console.log('[delma prompt] tab changed:', tabKey, 'wasDismissed:', wasDismissed, 'grace until:', new Date(Date.now() + TAB_CHANGE_GRACE_MS).toLocaleTimeString())
}

// Track user activity — only show prompts when idle
document.addEventListener('keydown', () => { lastActivity = Date.now() })
document.addEventListener('scroll', () => { lastActivity = Date.now() }, true)
document.addEventListener('pointermove', () => { lastActivity = Date.now() })

function getCurrentTabContent() {
  if (state.activeTopTab === 'orgMemory') return state.orgMemory[state.activeMemoryFile] || ''
  if (state.activeTopTab === 'memory') return state.memory[state.activeMemoryFile] || ''
  if (state.activeTopTab === 'diagram') {
    const view = getActiveView()
    return view ? `${view.title}\n${view.description}\n${view.mermaid}` : ''
  }
  return ''
}

function getCurrentTabKey() {
  if (state.activeTopTab === 'orgMemory') return `org:${state.activeMemoryFile}`
  if (state.activeTopTab === 'memory') return `mem:${state.activeMemoryFile}`
  if (state.activeTopTab === 'diagram') return `dia:${state.activeViewKey}`
  return ''
}

async function askDeepSeekForGap(content, tabTitle) {
  console.log('[delma gap] checking for gaps in:', tabTitle, 'contentLen:', content.length)
  const apiKey = import.meta.env.VITE_DEEPSEEK_API_KEY
  if (!apiKey) { console.log('[delma gap] no API key'); return null }

  const t0 = performance.now()
  try {
    const res = await fetch('https://api.deepseek.com/v1/chat/completions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${apiKey}` },
      body: JSON.stringify({
        model: 'deepseek-chat',
        max_tokens: 80,
        messages: [{
          role: 'user',
          content: `You are reviewing a project workspace tab called "${tabTitle}" in a Salesforce Marketing Cloud project. Here is the current content:\n\n${content.slice(0, 2000)}\n\nAsk one short question about a missing or unclear detail that a project manager would want answered. Focus on: who approves things, what happens next, timing, ownership, or process gaps.\n\nRespond with ONLY a natural question, 5-12 words. Examples:\n- "Who approves go-live for this campaign?"\n- "What happens after the third follow-up email?"\n- "When was this last tested end-to-end?"\n\nDo NOT ask about technical IDs, API keys, or system configuration. Only ask about business and operational gaps.\n\nIf the content seems complete, respond with exactly: NONE`
        }]
      })
    })
    console.log('[delma gap] DeepSeek response:', res.status, 'in', Math.round(performance.now() - t0), 'ms')
    if (!res.ok) return null
    const data = await res.json()
    const answer = data.choices?.[0]?.message?.content?.trim()
    if (!answer || answer === 'NONE' || answer.length > 120) {
      console.log('[delma gap] no question (NONE or empty)')
      return null
    }
    console.log('[delma gap] question:', answer)
    return answer
  } catch (err) {
    console.error('[delma gap] error:', err.message)
    return null
  }
}

let activePromptTimer = null

function showPrompt(question, tabKey) {
  if (activePromptTimer) clearTimeout(activePromptTimer)

  // Same spot, different intent based on mode
  const modeClass = state.diagramMode === 'edit' ? 'mode-edit' : 'mode-view'

  // Answer handler for proactive questions
  // Uses DeepSeek to intelligently update the content (including Mermaid diagrams)
  // instead of just appending raw text.
  async function onApply(answer, q) {
    console.log('[delma onApply] answer:', answer, 'question:', q)
    const { updatedTabs } = await routeAndPatchFact(answer, q)
    if (!updatedTabs.length) {
      setWorkspaceStatus('Noted — nothing needed updating.')
      return
    }
    const names = updatedTabs.map(t => t.title).join(', ')
    setWorkspaceStatus(`Updated: ${names}`)
  }

  // Stop polling while a question is visible — prevents re-rendering the block
  if (promptTimer) { clearInterval(promptTimer); promptTimer = null }
  console.log('[delma prompt] showing question:', question, 'mode:', modeClass, 'tabKey:', tabKey)

  renderActionBlock(question, modeClass, onApply)

  // Auto-dismiss after 25 seconds — revert based on mode, restart polling
  activePromptTimer = setTimeout(() => {
    console.log('[delma prompt] auto-dismissed after 25s, tabKey:', tabKey)
    if (state.diagramMode === 'edit') {
      // Revert to general edit prompt
      renderActionBlock('What do you want to update?', 'mode-edit')
    } else {
      removeActionBlock()
    }
    dismissedTabs.add(tabKey)
    // Restart polling after dismiss
    promptTimer = setInterval(maybeShowPrompt, 5 * 60 * 1000)
  }, 25000)
}

async function maybeShowPrompt() {
  console.log('[delma prompt] maybeShowPrompt tick, workspace:', !!state.workspaceId, 'mode:', state.diagramMode)
  if (!state.workspaceId) return
  if (state.diagramMode === 'edit') { console.log('[delma prompt] skipped (edit mode)'); return }

  const tabKey = getCurrentTabKey()
  if (!tabKey || dismissedTabs.has(tabKey)) { console.log('[delma prompt] skipped (no tab or dismissed):', tabKey); return }

  // Grace period after a content change — let the user see their own edit first.
  const changedAt = tabChangedAt.get(tabKey)
  if (changedAt && Date.now() - changedAt < TAB_CHANGE_GRACE_MS) {
    const remainMs = TAB_CHANGE_GRACE_MS - (Date.now() - changedAt)
    console.log('[delma prompt] skipped (in ' + Math.round(remainMs / 1000) + 's grace after edit)')
    return
  }

  if (Date.now() - lastActivity < 3000) { console.log('[delma prompt] skipped (user active)'); return }

  const content = getCurrentTabContent()
  if (!content || content.length < 20) return

  const tabTitle = state.activeTopTab === 'orgMemory'
    ? (ORG_TAB_LABELS[state.activeMemoryFile]?.title || state.activeMemoryFile)
    : state.activeTopTab === 'memory'
      ? (MEMORY_TAB_LABELS[state.activeMemoryFile]?.title || state.activeMemoryFile)
      : (getActiveView()?.title || 'Architecture')

  const question = await askDeepSeekForGap(content, tabTitle)

  if (question) {
    showPrompt(question, tabKey)
  }
}

function startPromptEngine() {
  console.log('[delma prompt] engine starting — first check in 30s, then every 5min')
  if (promptTimer) clearInterval(promptTimer)
  setTimeout(() => {
    console.log('[delma prompt] first tick firing')
    maybeShowPrompt()
    promptTimer = setInterval(maybeShowPrompt, 5 * 60 * 1000)
  }, 30000)
}

// ── Chat collapse toggle ──────────────────────────────────────────────────
//
// Chat is in a grid column, open by default. The toggle collapses it to a
// thin 40px rail so the diagram gets full viewport width when needed.
// State is persisted in localStorage.
function setupChatToggle() {
  const shell = document.querySelector('.app-shell')
  const btn = document.getElementById('chat-toggle')
  const icon = document.getElementById('chat-toggle-icon')
  if (!shell || !btn) return

  const KEY = 'delma.chat.collapsed'
  const setCollapsed = (collapsed) => {
    shell.classList.toggle('chat-collapsed', collapsed)
    btn.setAttribute('aria-label', collapsed ? 'Expand chat' : 'Collapse chat')
    btn.title = collapsed ? 'Expand chat (⌘\\)' : 'Collapse chat (⌘\\)'
    if (icon) icon.textContent = collapsed ? '‹' : '›'
    try { localStorage.setItem(KEY, collapsed ? '1' : '0') } catch {}
  }

  // Default: open. Restore prior state if set.
  let initial = false
  try { initial = localStorage.getItem(KEY) === '1' } catch {}
  setCollapsed(initial)

  btn.addEventListener('click', () => {
    setCollapsed(!shell.classList.contains('chat-collapsed'))
  })
  document.addEventListener('keydown', (e) => {
    if ((e.metaKey || e.ctrlKey) && e.key === '\\') {
      e.preventDefault()
      setCollapsed(!shell.classList.contains('chat-collapsed'))
    }
  })
}

// ── Layout debug ───────────────────────────────────────────────────────────
//
// Dumps the current layout measurements to the console. Call window.delmaDebug()
// at any time from DevTools, or watch the automatic logs on resize/render.
function delmaDebugLayout(tag = 'manual') {
  const q = (sel) => document.querySelector(sel)
  const measure = (el) => el ? {
    clientW: el.clientWidth,
    scrollW: el.scrollWidth,
    offsetW: el.offsetWidth,
    rectL: Math.round(el.getBoundingClientRect().left),
    rectR: Math.round(el.getBoundingClientRect().right),
    overflows: el.scrollWidth > el.clientWidth + 1
  } : null

  const shell = q('.app-shell')
  const panel = q('.workspace-panel')
  const chat = q('.chat-sidebar')
  const header = q('.workspace-header')
  const tabRow = q('.tab-row')
  const tabBar = q('.tab-bar')
  const meta = q('.diagram-meta')
  const stage = q('.diagram-stage')
  const card = q('.diagram-card')
  const wrapper = q('.diagram-zoom-wrapper')
  const canvas = q('.diagram-zoom-canvas')
  const svg = wrapper?.querySelector('svg')

  const data = {
    tag,
    viewport: { w: window.innerWidth, h: window.innerHeight },
    shellGrid: shell ? getComputedStyle(shell).gridTemplateColumns : null,
    chatCollapsed: shell?.classList.contains('chat-collapsed') || false,
    panel: measure(panel),
    chat: measure(chat),
    header: measure(header),
    tabRow: measure(tabRow),
    tabBar: measure(tabBar),
    meta: measure(meta),
    stage: measure(stage),
    card: measure(card),
    wrapper: measure(wrapper),
    canvas: measure(canvas),
    svg: svg ? {
      viewBox: svg.getAttribute('viewBox'),
      width: svg.getAttribute('width'),
      height: svg.getAttribute('height'),
      baseW: svg.dataset.baseWidth,
      baseH: svg.dataset.baseHeight,
      transform: svg.style.transform
    } : null
  }

  // Find elements inside the panel that extend past its right edge
  if (panel) {
    const pr = Math.round(panel.getBoundingClientRect().right)
    const overflowers = []
    for (const el of panel.querySelectorAll('*')) {
      const r = el.getBoundingClientRect()
      if (r.width > 0 && Math.round(r.right) > pr + 1) {
        overflowers.push({
          tag: el.tagName.toLowerCase(),
          cls: (el.className || '').toString().slice(0, 60),
          id: el.id,
          rectR: Math.round(r.right),
          diff: Math.round(r.right - pr)
        })
        if (overflowers.length >= 8) break
      }
    }
    data.panelRight = pr
    data.overflowingPastPanel = overflowers
  }

  console.log('[delma layout]', tag, JSON.stringify(data, null, 2))
  return data
}
window.delmaDebug = delmaDebugLayout

function wireLayoutDebug() {
  // Log at key moments
  window.addEventListener('resize', () => {
    clearTimeout(window.__delmaResizeT)
    window.__delmaResizeT = setTimeout(() => delmaDebugLayout('resize'), 200)
  })
  // Log on tab switches
  const origRender = renderWorkspace
  // (renderWorkspace is already async and exported; just log when diagram mounts)
  const obs = new MutationObserver(() => {
    if (document.querySelector('.diagram-zoom-wrapper')) {
      obs.disconnect()
      setTimeout(() => delmaDebugLayout('diagram-rendered'), 100)
    }
  })
  if (document.body) obs.observe(document.body, { childList: true, subtree: true })
}

void init().then(() => {
  console.log('[delma] init done, starting prompt engine')
  setupChatToggle()
  wireLayoutDebug()
  delmaDebugLayout('post-init')
  startPromptEngine()
}).catch(err => console.error('[delma] INIT CRASHED:', err))
