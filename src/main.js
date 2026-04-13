import mermaid from 'mermaid'
import elkLayouts from '@mermaid-js/layout-elk'
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
  workspaceId: null,
  workspaceName: '',
  workspaces: [],
  views: [],
  memory: {},
  history: [],
  activeViewKey: null,
  activeMemoryFile: null,
  previewMermaid: '',
  activeTopTab: 'diagram',
  documentationContent: '',
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
  workspaceTitle: document.getElementById('workspace-title'),
  workspaceCopy: document.getElementById('workspace-copy'),
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

// ── Workspace CRUD ───────────────────────────────────────────────────────────

async function loadWorkspaces() {
  if (!state.user) return
  const { data } = await supabase
    .from('workspace_members')
    .select('workspace_id, role, workspaces(id, name, created_at)')
    .eq('user_id', state.user.id)
  state.workspaces = (data || []).map(r => ({ ...r.workspaces, role: r.role }))
}

async function createWorkspace(name) {
  const { data: ws, error } = await supabase
    .from('workspaces')
    .insert({ name, created_by: state.user.id })
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
  setWorkspaceStatus('Workspace open. Claude Code can connect via Delma MCP.')
  appendLog('Workspace Open', `Connected to workspace. Diagrams and memory are live.`)
}

// ── Data Loading ─────────────────────────────────────────────────────────────

async function refreshWorkspace() {
  if (!state.workspaceId || !state.user) return

  const [{ data: views }, { data: memory }, { data: history }, { data: ws }] = await Promise.all([
    supabase.from('diagram_views').select('*').eq('workspace_id', state.workspaceId)
      .or(`visibility.eq.shared,owner_id.eq.${state.user.id}`).order('view_key'),
    supabase.from('memory_notes').select('*').eq('workspace_id', state.workspaceId)
      .or(`visibility.eq.shared,owner_id.eq.${state.user.id}`),
    supabase.from('history_snapshots').select('id, reason, created_at')
      .eq('workspace_id', state.workspaceId).order('created_at', { ascending: false }).limit(30),
    supabase.from('workspaces').select('name').eq('id', state.workspaceId).single()
  ])

  state.views = views || []
  state.memory = {}
  for (const row of (memory || [])) state.memory[row.filename] = row.content
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
  if (state.activeTopTab === 'documentation') {
    els.diagramOutput.hidden = mode === 'edit'
    if (mode === 'edit') els.diagramEditor.value = state.documentationContent || ''
    els.diagramEditor.classList.toggle('visible', mode === 'edit')
  } else {
    els.diagramOutput.hidden = mode === 'edit'
    els.diagramEditor.classList.toggle('visible', mode === 'edit')
  }
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

function buildDocumentationPreview() {
  const sections = ['# High Level Project Details', '', 'Generated by Delma.', '']
  for (const view of state.views) {
    sections.push(`### ${view.title}`)
    if (view.description) sections.push(view.description)
    if (view.summary) sections.push('', view.summary)
    sections.push('')
  }
  const entries = Object.entries(state.memory).filter(([, v]) => v?.trim())
  if (entries.length) {
    sections.push('## Reference Notes', '')
    for (const [file, content] of entries) sections.push(`### ${file}`, '', content.trim(), '')
  }
  return sections.join('\n').trim()
}

// ── Tab Labels for Memory Files ──────────────────────────────────────────────

const MEMORY_TAB_LABELS = {
  'environment.md': { title: 'Environment', desc: 'IDs, URLs, infrastructure, and where things live in SFMC.' },
  'logic.md': { title: 'Campaign Logic', desc: 'Business rules, routing, how the campaign works.' },
  'people.md': { title: 'People', desc: 'Who owns what, stakeholders, key decisions.' },
  'session-log.md': { title: 'Session Log', desc: 'Current status, what\'s done, what\'s needed.' }
}

// ── Render ───────────────────────────────────────────────────────────────────

function renderViewTabs() {
  els.viewTabs.textContent = ''

  // Diagram tabs
  const views = state.views.length ? state.views : defaultViewTemplates()
  for (const view of views) {
    const btn = document.createElement('button')
    const key = view.view_key
    const isActive = state.activeTopTab === 'diagram' && key === state.activeViewKey
    btn.className = `view-tab${isActive ? ' active' : ''}`
    btn.innerHTML = `<div class="view-tab-title">${escapeHtml(view.title)}</div>`
    btn.addEventListener('click', () => {
      saveCurrentEditState()
      state.activeTopTab = 'diagram'
      state.activeViewKey = key
      state.previewMermaid = view.mermaid || ''
      renderWorkspace()
    })
    els.viewTabs.appendChild(btn)
  }

  // Memory file tabs
  const memFiles = Object.keys(state.memory).length ? Object.keys(state.memory) : Object.keys(MEMORY_TAB_LABELS)
  for (const filename of memFiles) {
    const label = MEMORY_TAB_LABELS[filename] || { title: filename, desc: '' }
    const isActive = state.activeTopTab === 'memory' && state.activeMemoryFile === filename
    const btn = document.createElement('button')
    btn.className = `view-tab${isActive ? ' active' : ''}`
    btn.innerHTML = `<div class="view-tab-title">${escapeHtml(label.title)}</div>`
    btn.addEventListener('click', () => {
      saveCurrentEditState()
      state.activeTopTab = 'memory'
      state.activeMemoryFile = filename
      renderWorkspace()
    })
    els.viewTabs.appendChild(btn)
  }

  // Project Details tab
  const docBtn = document.createElement('button')
  docBtn.className = `view-tab action-tab${state.activeTopTab === 'documentation' ? ' active' : ''}`
  docBtn.innerHTML = '<div class="view-tab-title">Overview</div>'
  docBtn.addEventListener('click', () => {
    saveCurrentEditState()
    state.activeTopTab = 'documentation'
    renderWorkspace()
  })
  els.viewTabs.appendChild(docBtn)
}

function populateEditor(view) {
  els.viewTitleInput.value = view?.title || ''
  els.viewDescriptionInput.value = view?.description || ''
  els.viewSummaryInput.value = view?.summary || ''
  els.viewMermaid.value = state.previewMermaid || view?.mermaid || ''
  els.diagramEditor.value = state.previewMermaid || view?.mermaid || ''
}

// ── Render a memory file as a readable document ─────────────────────────────

function renderMemoryDocument(filename) {
  const content = state.memory[filename] || ''
  const label = MEMORY_TAB_LABELS[filename] || { title: filename, desc: '' }

  els.viewTitle.textContent = label.title
  els.viewDescription.textContent = label.desc
  els.modeToggle.hidden = false
  els.resetExampleBtn.hidden = true

  if (state.diagramMode === 'edit') {
    els.diagramOutput.hidden = true
    els.diagramEditor.classList.add('visible')
    els.diagramEditor.value = content
  } else {
    els.diagramOutput.hidden = false
    els.diagramEditor.classList.remove('visible')
    els.diagramOutput.className = 'documentation-shell'
    els.diagramOutput.innerHTML = ''

    const pre = document.createElement('pre')
    pre.style.cssText = 'font-size: 13px; line-height: 1.7; white-space: pre-wrap; color: #333; font-family: var(--sans); padding: 8px 0;'
    pre.textContent = content.trim() || '(empty)'
    els.diagramOutput.appendChild(pre)
  }
}

// ── Render the overview tab (diagrams + memory summary) ─────────────────────

async function renderDocumentation() {
  els.viewTitle.textContent = 'Overview'
  els.viewDescription.textContent = 'All diagrams and notes in one view.'
  els.modeToggle.hidden = true
  els.resetExampleBtn.hidden = true
  els.diagramOutput.hidden = false
  els.diagramEditor.classList.remove('visible')
  els.diagramOutput.className = 'documentation-shell'
  els.diagramOutput.innerHTML = ''

  for (const view of state.views) {
    const section = document.createElement('div')
    section.style.cssText = 'margin-bottom: 36px;'

    const heading = document.createElement('h3')
    heading.style.cssText = 'font-size: 16px; font-weight: 700; margin-bottom: 4px;'
    heading.textContent = view.title
    section.appendChild(heading)

    if (view.description) {
      const desc = document.createElement('p')
      desc.style.cssText = 'font-size: 13px; color: #666; margin-bottom: 12px;'
      desc.textContent = view.description
      section.appendChild(desc)
    }

    if (view.mermaid?.trim()) {
      const diagramDiv = document.createElement('div')
      try {
        const { svg } = await mermaid.render(`doc-${view.view_key}-${Date.now()}`, view.mermaid)
        diagramDiv.innerHTML = svg
      } catch (e) {
        diagramDiv.textContent = `(render error: ${e.message})`
        diagramDiv.style.cssText = 'color: #999; font-size: 12px;'
      }
      section.appendChild(diagramDiv)
    }
    els.diagramOutput.appendChild(section)
  }

  const entries = Object.entries(state.memory).filter(([, v]) => v?.trim())
  if (entries.length) {
    for (const [file, content] of entries) {
      const label = MEMORY_TAB_LABELS[file] || { title: file }
      const section = document.createElement('div')
      section.style.cssText = 'margin-bottom: 24px; border-top: 1px solid rgba(0,0,0,0.06); padding-top: 20px;'

      const heading = document.createElement('h3')
      heading.style.cssText = 'font-size: 15px; font-weight: 700; margin-bottom: 8px;'
      heading.textContent = label.title
      section.appendChild(heading)

      const pre = document.createElement('pre')
      pre.style.cssText = 'font-size: 12px; line-height: 1.6; white-space: pre-wrap; color: #555; background: #f9f9f9; padding: 12px; border-radius: 6px;'
      pre.textContent = content.trim()
      section.appendChild(pre)

      els.diagramOutput.appendChild(section)
    }
  }
}

// ── Main renderWorkspace ────────────────────────────────────────────────────

function renderWorkspace() {
  renderViewTabs()

  els.workspaceTitle.textContent = state.workspaceName || 'Delma Workspace'
  els.workspaceCopy.textContent = state.workspaceId
    ? 'Visual workspace for Claude Code. Diagrams and memory update live.'
    : 'Select or create a workspace to get started.'

  // Documentation / Overview tab
  if (state.activeTopTab === 'documentation') {
    void renderDocumentation()
    return
  }

  // Memory file tab
  if (state.activeTopTab === 'memory') {
    renderMemoryDocument(state.activeMemoryFile)
    return
  }

  // Diagram tab
  const view = getActiveView()
  if (!view) {
    void renderDiagram('')
    return
  }

  els.modeToggle.hidden = false
  els.resetExampleBtn.hidden = false
  els.viewTitle.textContent = view.title
  els.viewDescription.textContent = view.description || ''
  populateEditor(view)
  setDiagramMode(state.diagramMode)
  if (state.diagramMode !== 'edit') void renderDiagram(state.previewMermaid || view.mermaid || '')
}

// ── Edit State ───────────────────────────────────────────────────────────────

function saveCurrentEditState() {
  if (state.diagramMode !== 'edit') return
  if (state.activeTopTab === 'memory') {
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

// ── Workspace Selector ───────────────────────────────────────────────────────

function renderWorkspaceSelector() {
  const dir = els.projectDir
  if (!dir) return

  // Repurpose the project-dir input as workspace selector
  dir.placeholder = 'Workspace name'
  dir.value = ''

  if (state.workspaces.length) {
    dir.placeholder = `${state.workspaces.length} workspace(s) — type a name to create new`
  }
}

// ── Event Listeners ──────────────────────────────────────────────────────────

els.connectBtn.addEventListener('click', () => {
  void (async () => {
    const input = els.projectDir.value.trim()
    if (!input) {
      // If no name typed, open first workspace or show error
      if (state.workspaces.length) {
        await openWorkspace(state.workspaces[0].id)
      } else {
        els.projectDir.focus()
        setWorkspaceStatus('Type a workspace name to create one.')
      }
      return
    }

    // Check if workspace exists
    const existing = state.workspaces.find(w => w.name.toLowerCase() === input.toLowerCase())
    if (existing) {
      await openWorkspace(existing.id)
    } else {
      const ws = await createWorkspace(input)
      state.workspaces.push({ ...ws, role: 'owner' })
      await openWorkspace(ws.id)
      appendLog('Workspace Created', `Created "${ws.name}" with default diagrams and memory.`)
    }

    els.sdkStatus.textContent = 'Workspace Open'
    els.connectBtn.textContent = 'Switch Workspace'
  })().catch(err => {
    setWorkspaceStatus(err.message)
    appendLog('Error', err.message, 'error')
  })
})

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
  if (state.activeTopTab === 'memory') {
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
    await loadWorkspaces()
    renderWorkspaceSelector()
    if (state.workspaces.length) {
      await openWorkspace(state.workspaces[0].id)
      els.sdkStatus.textContent = 'Workspace Open'
      els.connectBtn.textContent = 'Switch Workspace'
    }
  })()
})

els.logoutBtn.addEventListener('click', () => {
  void logout().then(() => {
    setWorkspaceStatus('Signed out.')
    els.sdkStatus.textContent = 'Signed Out'
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
  Code["Local Code"] --> Sync
  Delma["Delma Memory"] --> Claude["Claude Code"]
  Claude --> Sync
`
    },
    {
      view_key: 'org',
      title: 'Org Chart',
      kind: 'people',
      description: 'Stakeholders, owners, decision-makers, and trust boundaries.',
      summary: 'Human org.',
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
    await loadWorkspaces()
    renderWorkspaceSelector()
    if (state.workspaces.length) {
      await openWorkspace(state.workspaces[0].id)
      els.sdkStatus.textContent = 'Workspace Open'
      els.connectBtn.textContent = 'Switch Workspace'
    } else {
      els.sdkStatus.textContent = 'No Workspaces'
      setWorkspaceStatus('Type a workspace name and click Open to create one.')
    }
  } else {
    els.sdkStatus.textContent = 'Sign In'
  }

  appendLog('Delma v2', 'Supabase-backed visual workspace. Diagrams and memory sync live between you and Claude Code.')
}

void init()
