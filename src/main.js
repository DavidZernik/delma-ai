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
  layout: 'elk',
  flowchart: { curve: 'basis', padding: 20, nodeSpacing: 40, rankSpacing: 60 },
  themeVariables: {
    primaryColor: '#FBF7F2',       // node fill — light warm white
    primaryTextColor: '#1A1A1A',   // node text
    primaryBorderColor: '#D8CFC4', // node border — warm defined edge
    secondaryColor: '#FBF7F2',     // alt node fill — same family
    secondaryTextColor: '#1A1A1A',
    secondaryBorderColor: '#D8CFC4',
    tertiaryColor: '#F5EDE4',      // background elements
    tertiaryTextColor: '#1A1A1A',
    tertiaryBorderColor: '#D8CFC4',
    lineColor: '#7A0000',          // arrows — slightly deeper red, confident
    textColor: '#1A1A1A',
    fontSize: '15px',
    fontFamily: '"Instrument Sans", "Avenir Next", "Segoe UI", sans-serif',
    nodeBorder: '#D8CFC4',
    nodeTextColor: '#1A1A1A',
    mainBkg: '#FBF7F2',
    edgeLabelBackground: '#FAF6F0',
    clusterBkg: '#F5EDE4',
    clusterBorder: '#D8CFC4'
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
  if (!state.user) { console.log('[delma] loadOrgs: no user'); return }
  const { data, error } = await supabase
    .from('org_members')
    .select('org_id, role, organizations(id, name, slug)')
    .eq('user_id', state.user.id)
  console.log('[delma] loadOrgs response:', { data, error: error?.message })
  state.orgs = (data || []).map(r => ({ ...r.organizations, orgRole: r.role }))
  if (state.orgs.length && !state.org) {
    state.org = state.orgs[0]
  }
  console.log('[delma] loadOrgs done:', state.orgs.length, 'orgs, active:', state.org?.name)
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
  els.viewModeBtn.hidden = mode !== 'edit'
  els.viewModeBtn.textContent = 'Cancel'
  els.viewModeBtn.classList.remove('active', 'primary')
  els.editModeBtn.textContent = mode === 'edit' ? 'Save' : 'Edit'
  els.editModeBtn.classList.toggle('primary', mode === 'edit')
  els.editModeBtn.classList.toggle('active', mode === 'view')
  els.diagramOutput.hidden = mode === 'edit'
  els.diagramEditor.classList.toggle('visible', mode === 'edit')
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

  for (const node of svg.querySelectorAll('.node rect, .node polygon')) {
    node.style.filter = 'drop-shadow(0 1px 3px rgba(0, 0, 0, 0.06))'
    node.setAttribute('rx', '8')
    node.setAttribute('ry', '8')
  }

  for (const edge of svg.querySelectorAll('.edgePath path.path')) {
    edge.style.strokeWidth = '2.5px'
  }

  for (const marker of svg.querySelectorAll('marker path')) {
    marker.style.fill = '#7A0000'
  }

  for (const label of svg.querySelectorAll('.nodeLabel')) {
    label.style.fontSize = '14px'
    label.style.fontWeight = '500'
    label.style.color = '#1A1A1A'
    label.style.fill = '#1A1A1A'
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
  console.log('[delma render] renderDiagram called, code length:', mermaidCode?.length || 0)
  if (!mermaidCode?.trim()) {
    console.log('[delma render] empty code, showing placeholder')
    els.diagramOutput.className = 'diagram-empty'
    els.diagramOutput.textContent = 'This view does not have Mermaid content yet.'
    return true
  }
  try {
    const renderId = `delma-diagram-${Date.now()}`
    const normalizedCode = normalizeMermaidForRender(mermaidCode)
    console.log('[delma render] normalized code:', normalizedCode.substring(0, 100) + '...')
    console.log('[delma render] calling mermaid.render...')
    const { svg } = await mermaid.render(renderId, normalizedCode)
    console.log('[delma render] mermaid.render success, svg length:', svg?.length || 0)
    els.diagramOutput.className = ''
    els.diagramOutput.style.opacity = '0'

    // Wrap SVG in zoom container with controls
    currentZoom = 1
    els.diagramOutput.innerHTML = `
      <div class="diagram-zoom-wrapper">
        <div class="diagram-zoom-canvas">${svg}</div>
      </div>
      <div class="diagram-zoom-controls">
        <button class="zoom-btn" data-zoom="in" title="Zoom in">+</button>
        <div class="zoom-level">100%</div>
        <button class="zoom-btn" data-zoom="out" title="Zoom out">&minus;</button>
      </div>
    `

    // Wire up zoom buttons
    els.diagramOutput.querySelector('[data-zoom="in"]').addEventListener('click', () => setZoom(currentZoom + ZOOM_STEP))
    els.diagramOutput.querySelector('[data-zoom="out"]').addEventListener('click', () => setZoom(currentZoom - ZOOM_STEP))

    // Pinch-to-zoom on touch
    const wrapper = els.diagramOutput.querySelector('.diagram-zoom-wrapper')
    const svgEl = wrapper.querySelector('svg')
    console.log('[delma render] svgEl found:', !!svgEl, 'wrapper size:', wrapper.clientWidth, 'x', wrapper.clientHeight)
    applyDiagramBranding(svgEl)
    console.log('[delma render] branding applied')
    const prepared = prepareFittedSvg(svgEl, wrapper)
    console.log('[delma render] prepareFittedSvg result:', prepared ? { fitScale: prepared.fitScale, bounds: { w: prepared.bounds.width, h: prepared.bounds.height, source: prepared.bounds.source } } : 'null')
    console.log('[delma render] prepareFittedSvg result:', prepared ? { bounds: { w: Math.round(prepared.bounds.width), h: Math.round(prepared.bounds.height) } } : 'null')
    enableDiagramDragging(wrapper)

    // Reveal first, then set zoom after layout settles
    // The wrapper needs real dimensions before we can size the canvas correctly
    requestAnimationFrame(() => {
      els.diagramOutput.style.opacity = '1'
      els.diagramOutput.style.transition = 'opacity 150ms ease'
      // Second frame: container now has real height
      requestAnimationFrame(() => {
        console.log('[delma render] post-layout wrapper size:', wrapper.clientWidth, 'x', wrapper.clientHeight)
        setZoom(1)
        console.log('[delma render] zoom set, currentZoom:', currentZoom)
      })
    })
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
  const code = normalizeMermaidForRender(els.diagramEditor.value || els.viewMermaid.value)
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
  console.log('[delma workspace] renderWorkspace called, activeTopTab:', state.activeTopTab, 'activeViewKey:', state.activeViewKey, 'activeMemoryFile:', state.activeMemoryFile)
  console.log('[delma workspace] views:', state.views.length, 'memory:', Object.keys(state.memory), 'orgMemory:', Object.keys(state.orgMemory))
  renderViewTabs()

  // Org memory tab (SFMC Setup, People)
  if (state.activeTopTab === 'orgMemory') {
    console.log('[delma workspace] rendering org memory tab:', state.activeMemoryFile)
    void renderMemoryDocument(state.activeMemoryFile, true)
    return
  }

  // Project memory tab
  if (state.activeTopTab === 'memory') {
    console.log('[delma workspace] rendering project memory tab:', state.activeMemoryFile)
    void renderMemoryDocument(state.activeMemoryFile)
    return
  }

  // Diagram tab
  const view = getActiveView()
  console.log('[delma workspace] diagram tab, view:', view ? { key: view.view_key, title: view.title, mermaid_length: view.mermaid?.length } : 'null')
  if (!view) {
    console.log('[delma workspace] no view, showing placeholder')
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
  els.viewDescription.textContent = view.description || ''
  els.viewProvenance.textContent = view.updated_at
    ? `Last saved ${timeAgo(view.updated_at)}`
    : ''
  populateEditor(view)
  setDiagramMode(state.diagramMode)

  if (state.diagramMode !== 'edit') {
    const mermaidCode = state.previewMermaid || view.mermaid || ''
    console.log('[delma workspace] rendering diagram, mermaid code length:', mermaidCode.length, 'first 80 chars:', mermaidCode.substring(0, 80))
    els.diagramOutput.className = ''
    void renderDiagram(mermaidCode)
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

els.viewModeBtn.addEventListener('click', () => {
  discardCurrentEditState()
  setDiagramMode('view')
  renderWorkspace()
  setWorkspaceStatus('Changes discarded.')
})

els.editModeBtn.addEventListener('click', () => {
  if (state.diagramMode === 'edit') {
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
      setDiagramMode('view')
      renderWorkspace()
    })().catch(err => {
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
  console.log('[delma] init started')
  console.log('[delma] els check:', Object.entries(els).map(([k, v]) => `${k}:${v ? 'OK' : 'NULL'}`).join(', '))

  els.sdkStatus.textContent = 'Checking auth...'
  els.connectBtn.textContent = 'Open Workspace'
  els.input.disabled = true
  els.sendBtn.disabled = true

  if (els.authCopy) els.authCopy.textContent = 'Sign in with your email and password.'
  if (els.authUsername) els.authUsername.placeholder = 'Email'
  if (els.projectDir) els.projectDir.placeholder = 'Workspace name'

  console.log('[delma] rendering default workspace...')
  renderWorkspace()

  console.log('[delma] checking auth...')
  const user = await checkAuth()
  console.log('[delma] auth result:', user ? `uid=${user.id}, email=${user.email}` : 'not logged in')

  if (user) {
    console.log('[delma] loading orgs...')
    await loadOrgs()
    console.log('[delma] orgs loaded:', state.orgs.length, state.orgs.map(o => o.name))
    console.log('[delma] active org:', state.org?.name || 'none')

    console.log('[delma] loading workspaces...')
    await loadWorkspaces()
    console.log('[delma] workspaces loaded:', state.workspaces.length, state.workspaces.map(w => w.name))

    console.log('[delma] rendering org selector...')
    renderOrgSelector()
    console.log('[delma] rendering project selector...')
    renderProjectSelector()

    if (state.workspaces.length) {
      console.log('[delma] opening workspace:', state.workspaces[0].name, state.workspaces[0].id)
      await openWorkspace(state.workspaces[0].id)
      console.log('[delma] workspace opened. views:', state.views.length, 'memory:', Object.keys(state.memory).length, 'orgMemory:', Object.keys(state.orgMemory).length)
    } else {
      console.log('[delma] no workspaces found')
      setWorkspaceStatus('Create a project to get started.')
    }
  }
  console.log('[delma] init complete')
}

void init().catch(err => console.error('[delma] INIT CRASHED:', err))
