import mermaid from 'mermaid'
import elkLayouts from '@mermaid-js/layout-elk'

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
  authEnabled: false,
  authenticated: false,
  username: '',
  projectDir: '',
  workspace: null,
  graph: null,
  memory: {},
  history: [],
  activeViewId: null,
  previewMermaid: '',
  activeTopTab: 'view',
  documentationContent: '',
  diagramMode: 'view'
}

const hostedPreviewMode = window.location.hostname.endsWith('.vercel.app')

const els = {
  projectDir: document.getElementById('project-dir'),
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
  authCopy: document.getElementById('auth-copy')
}

const starterTemplates = defaultViewTemplates()

function appendLog(title, body, tone = 'assistant') {
  const node = document.createElement('div')
  node.className = `message ${tone}`
  node.textContent = `${title}\n\n${body}`
  els.sdkBody.prepend(node)
}

function setActivity(text) {
  els.activityRail.textContent = text
}

function setWorkspaceStatus(text) {
  els.workspaceStatus.textContent = text
}

function setDiagramMode(mode) {
  state.diagramMode = mode
  const editingDiagram = state.activeTopTab === 'view'
  els.modeToggle.hidden = !editingDiagram
  els.viewModeBtn.classList.toggle('active', editingDiagram && mode === 'view')
  els.editModeBtn.classList.toggle('active', editingDiagram && mode === 'edit')
  els.diagramOutput.hidden = editingDiagram && mode === 'edit'
  els.diagramEditor.classList.toggle('visible', editingDiagram && mode === 'edit')
}

function setAuthUi(authenticated) {
  state.authenticated = authenticated
  els.authOverlay.classList.toggle('visible', state.authEnabled && !authenticated)
  els.authOverlay.setAttribute('aria-hidden', String(!(state.authEnabled && !authenticated)))
  els.logoutBtn.classList.toggle('visible', state.authEnabled && authenticated)
}

async function apiFetch(url, options = {}) {
  const response = await fetch(url, options)
  if (response.status === 401) {
    state.authenticated = false
    setAuthUi(false)
    throw new Error('Please sign in to Delma.')
  }
  return response
}

async function checkAuth() {
  let response
  try {
    response = await fetch('/api/auth/status')
  } catch {
    state.authEnabled = false
    state.authenticated = true
    setAuthUi(true)
    return
  }

  if (!response.ok) {
    state.authEnabled = false
    state.authenticated = true
    setAuthUi(true)
    return
  }

  const data = await response.json()
  state.authEnabled = Boolean(data.authEnabled)
  state.authenticated = Boolean(data.authenticated)
  state.username = data.username || ''
  if (state.authEnabled) {
    els.authUsername.value = state.username || ''
    els.authCopy.textContent = state.username
      ? `Use the Delma login for ${state.username}.`
      : 'Use your personal Delma login to open the workspace.'
  }
  setAuthUi(state.authenticated)
}

async function login(username, password) {
  const response = await fetch('/api/auth/login', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username, password })
  })
  const data = await response.json()
  if (!response.ok) throw new Error(data.error || 'Unable to sign in')
  state.authEnabled = Boolean(data.authEnabled ?? state.authEnabled)
  state.authenticated = true
  state.username = data.username || username
  els.authError.textContent = ''
  els.authPassword.value = ''
  setAuthUi(true)
}

async function logout() {
  await fetch('/api/auth/logout', { method: 'POST' })
  state.authenticated = false
  setAuthUi(false)
}

function setOpenState(isOpen) {
  els.sdkStatus.textContent = hostedPreviewMode
    ? 'Workspace Ready'
    : isOpen
      ? 'Workspace Open'
      : 'Waiting For Workspace'
  els.connectBtn.textContent = hostedPreviewMode
    ? 'Runs Locally'
    : isOpen
      ? 'Reload Workspace'
      : 'Open Workspace'
  els.input.disabled = true
  els.sendBtn.disabled = true
}

function getActiveView() {
  const views = state.workspace?.views?.length ? state.workspace.views : starterTemplates
  return views.find((view) => view.id === state.activeViewId) || views[0] || null
}

function escapeHtml(text) {
  return String(text ?? '')
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;')
}

function trimPreview(text) {
  if (!text) return ''
  return text.length > 340 ? `${text.slice(0, 337)}...` : text
}

function buildDocumentationPreview(workspace, memory) {
  const sections = [
    '# High Level Documentation',
    '',
    'Generated by Delma from the shared workspace.',
    ''
  ]

  const views = workspace?.views || []
  if (views.length) {
    sections.push('## Diagram Views', '')
    for (const view of views) {
      sections.push(`### ${view.title}`)
      if (view.description) sections.push(view.description)
      if (view.summary) sections.push('', view.summary)
      sections.push('')
    }
  }

  const entries = Object.entries(memory || {}).filter(([, value]) => value && value.trim())
  if (entries.length) {
    sections.push('## Reference Notes', '')
    for (const [file, content] of entries) {
      sections.push(`### ${file}`, '', content.trim(), '')
    }
  }

  return sections.join('\n').trim()
}

function renderViewTabs() {
  const views = state.workspace?.views?.length ? state.workspace.views : starterTemplates
  els.viewTabs.textContent = ''

  if (!views.length) {
    els.viewTabs.innerHTML = '<div class="history-item">No diagram tabs yet.</div>'
    return
  }

  for (const view of views) {
    const button = document.createElement('button')
    button.className = `view-tab${state.activeTopTab === 'view' && view.id === state.activeViewId ? ' active' : ''}`
    button.innerHTML = `
      <div class="view-tab-title">${escapeHtml(view.title)}</div>
      <div class="view-tab-copy">${escapeHtml(view.description || 'No description yet.')}</div>
    `
    button.addEventListener('click', () => {
      state.activeTopTab = 'view'
      state.activeViewId = view.id
      state.previewMermaid = view.mermaid || ''
      renderWorkspace()
    })
    els.viewTabs.appendChild(button)
  }

  const docButton = document.createElement('button')
  docButton.className = `view-tab action-tab${state.activeTopTab === 'documentation' ? ' active' : ''}`
  docButton.innerHTML = '<div class="view-tab-title">High Level Documentation</div>'
  docButton.addEventListener('click', () => {
    void openDocumentationTab().catch((error) => {
      setWorkspaceStatus(error.message)
      appendLog('Documentation Failed', error.message, 'error')
    })
  })
  els.viewTabs.appendChild(docButton)
}

function renderHistory() {
  els.historyList.textContent = ''
  if (!state.history.length) {
    els.historyList.innerHTML = '<div class="history-item">No snapshots yet. Saving the workspace will create versioned history.</div>'
    return
  }

  for (const file of state.history.slice(0, 12)) {
    const item = document.createElement('div')
    item.className = 'history-item'
    item.textContent = file
    els.historyList.appendChild(item)
  }
}

function renderMemory() {
  els.memoryList.textContent = ''
  const entries = Object.entries(state.memory || {})
  if (!entries.length) {
    els.memoryList.innerHTML = '<div class="memory-item"><h4>Waiting</h4><pre>No memory files loaded yet.</pre></div>'
    return
  }

  for (const [file, content] of entries) {
    const item = document.createElement('div')
    item.className = 'memory-item'
    item.innerHTML = `<h4>${escapeHtml(file)}</h4><pre>${escapeHtml(trimPreview(content))}</pre>`
    els.memoryList.appendChild(item)
  }
}

function populateEditor(view) {
  els.viewTitleInput.value = view?.title || ''
  els.viewDescriptionInput.value = view?.description || ''
  els.viewSummaryInput.value = view?.summary || ''
  els.viewMermaid.value = state.previewMermaid || view?.mermaid || ''
  els.diagramEditor.value = state.previewMermaid || view?.mermaid || ''
}

async function renderDiagram(mermaidCode) {
  if (!mermaidCode?.trim()) {
    els.diagramOutput.className = 'diagram-empty'
    els.diagramOutput.textContent = 'This view does not have Mermaid content yet.'
    return
  }

  try {
    const renderId = `delma-diagram-${Date.now()}`
    const { svg } = await mermaid.render(renderId, mermaidCode)
    els.diagramOutput.className = ''
    els.diagramOutput.innerHTML = svg
  } catch (error) {
    els.diagramOutput.className = 'diagram-empty'
    els.diagramOutput.textContent = `Unable to render Mermaid right now.\n\n${error.message}`
  }
}

async function renderDocumentation(content) {
  setDiagramMode('view')
  els.diagramOutput.className = 'documentation-shell'
  els.diagramOutput.textContent = content?.trim() || 'No High Level Documentation yet.'
}

function renderWorkspace() {
  renderViewTabs()
  renderHistory()
  renderMemory()

  const view = getActiveView()
  if (!view) {
    els.workspaceTitle.textContent = 'Delma Workspace'
    els.workspaceCopy.textContent = 'Open a workspace to load Delma memory, connections, and diagram tabs.'
    els.viewTitle.textContent = 'No active view'
    els.viewDescription.textContent = ''
    els.viewSummary.textContent = ''
    els.modeToggle.hidden = true
    els.resetExampleBtn.hidden = true
    populateEditor(null)
    void renderDiagram('')
    return
  }

  els.workspaceTitle.textContent = state.workspace?.projectName ? `${state.workspace.projectName} Workspace` : 'Delma Workspace'
  els.workspaceCopy.textContent = state.workspace
    ? 'Claude Code is the worker. Delma is the shared operational memory sidecar for SFMC and Salesforce.'
    : 'Keep the shared SFMC and Salesforce map visible, even before the workspace details are fully filled in.'
  if (state.activeTopTab === 'documentation') {
    els.viewTitle.textContent = 'High Level Documentation'
    els.viewDescription.textContent = 'The shared top-level reference generated from Delma memory, diagrams, and workspace notes.'
    els.viewSummary.textContent = 'Use this as the clean, non-technical handoff document for Claude, stakeholders, and future sessions.'
    els.resetExampleBtn.hidden = true
    void renderDocumentation(state.documentationContent || buildDocumentationPreview(state.workspace, state.memory))
    return
  }

  els.modeToggle.hidden = false
  els.resetExampleBtn.hidden = false
  els.viewTitle.textContent = view.title
  els.viewDescription.textContent = view.description || 'No description yet.'
  els.viewSummary.textContent = view.summary || 'No summary yet.'
  els.projectPill.textContent = state.projectDir || 'No local path attached'
  els.historyPill.textContent = `${state.history.length} snapshots`
  els.diagramToolbarTitle.textContent = view.title
  els.diagramToolbarSubtitle.textContent = view.kind ? `${view.kind} view` : 'Mermaid view'
  els.saveNote.textContent = 'Claude Code should update these views through the Delma MCP server. Manual edits here stay versioned too.'
  populateEditor(view)
  setDiagramMode(state.diagramMode)
  if (state.diagramMode === 'edit') {
    els.diagramOutput.className = ''
    els.diagramOutput.innerHTML = ''
    return
  }
  void renderDiagram(state.previewMermaid || view.mermaid || '')
}

async function refreshWorkspace() {
  if (!state.projectDir) return
  const response = await apiFetch('/api/delma/state')
  const data = await response.json()
  if (!response.ok) throw new Error(data.error || 'Unable to load Delma state')

  state.workspace = data.workspace
  state.graph = data.graph
  state.memory = data.memory || {}
  state.history = data.history || []

  if (!state.activeViewId || !state.workspace.views.some((view) => view.id === state.activeViewId)) {
    state.activeViewId = state.workspace.views?.[0]?.id || null
  }

  const activeView = getActiveView()
  state.previewMermaid = activeView?.mermaid || ''
  if (state.activeTopTab === 'documentation' && !state.documentationContent) {
    state.documentationContent = buildDocumentationPreview(state.workspace, state.memory)
  }
  renderWorkspace()
}

async function saveWorkspace(reason = 'workspace-save') {
  if (!state.workspace) return
  const response = await apiFetch('/api/delma/workspace', {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      reason,
      workspace: state.workspace
    })
  })
  const data = await response.json()
  if (!response.ok) throw new Error(data.error || 'Unable to save workspace')
  state.workspace = data.workspace
  await refreshWorkspace()
  setWorkspaceStatus(`Saved workspace and snapshot ${data.snapshotFile}`)
  appendLog('Workspace Saved', `Snapshot ${data.snapshotFile} written and High Level Documentation refreshed.`)
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

async function openProject() {
  if (hostedPreviewMode) {
    setWorkspaceStatus('This Delma workspace is available here. Local runtime adds MCP, optional local assets, and live Salesforce connections.')
    setActivity('Delma is available here as the shared workspace shell. Run it locally for MCP, optional local files, and live High Level Documentation updates.')
    appendLog(
      'Delma Workspace',
      [
        'This Delma deployment is the shared workspace shell.',
        'The real Delma sidecar still runs locally on your machine.',
        'Use Delma as a shared SFMC and Salesforce workspace, with optional local files when you need them.',
        'For full Delma: run `npm run dev` and `npm run start:mcp` locally.'
      ].join('\n')
    )
    return
  }

  const dir = els.projectDir.value.trim()
  if (!dir) {
    els.projectDir.focus()
    return
  }

  state.projectDir = dir
  setActivity('Opening the Delma workspace and refreshing High Level Documentation...')
  const response = await apiFetch('/api/project/open', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ projectDir: dir })
  })
  const data = await response.json()
  if (!response.ok) throw new Error(data.error || 'Unable to open workspace')

  setOpenState(true)
  await refreshWorkspace()
  setWorkspaceStatus('Workspace opened. Claude Code can now connect to Delma via MCP.')
  setActivity('Delma is ready. Attach local assets when needed, and let Claude Code call it while you work.')
  appendLog(
    'How Delma Fits',
    [
      '1. Keep working in Claude Code.',
      '2. Run `npm run start:mcp` in this repo.',
      '3. Add the Delma server from `.mcp.json.example` to your Claude Code MCP config.',
      '4. Use Delma as the shared memory for SFMC, Salesforce CRM, and optional local assets.'
    ].join('\n')
  )
}

async function composeClaudeMd() {
  if (hostedPreviewMode) {
    state.documentationContent = buildDocumentationPreview(state.workspace, state.memory)
    state.activeTopTab = 'documentation'
    setWorkspaceStatus(`Refreshed High Level Documentation (${state.documentationContent.length} chars)`)
    appendLog('High Level Documentation Refreshed', `Regenerated the shared documentation from Delma memory and diagrams. Length: ${state.documentationContent.length} chars.`)
    renderWorkspace()
    return
  }

  const response = await apiFetch('/api/memory/compose', { method: 'POST' })
  const data = await response.json()
  if (!response.ok) throw new Error(data.error || 'Unable to refresh High Level Documentation')

  const contentResponse = await apiFetch('/api/memory/CLAUDE.md')
  const contentData = await contentResponse.json()
  if (!contentResponse.ok) throw new Error(contentData.error || 'Unable to load High Level Documentation')

  state.documentationContent = contentData.content || ''
  state.activeTopTab = 'documentation'
  setWorkspaceStatus(`Refreshed High Level Documentation (${data.length} chars)`)
  appendLog('High Level Documentation Refreshed', `Regenerated the shared documentation from Delma memory and diagrams. Length: ${data.length} chars.`)
  renderWorkspace()
}

async function openDocumentationTab() {
  await composeClaudeMd()
}

function resetActiveView() {
  const currentId = state.activeViewId
  if (!currentId) return
  const template = starterTemplates.find((view) => view.id === currentId)
  if (!template) return
  const view = getActiveView()
  Object.assign(view, template)
  state.previewMermaid = view.mermaid
  els.diagramEditor.value = view.mermaid
  renderWorkspace()
  setWorkspaceStatus(`Restored ${view.title} to the saved Delma baseline.`)
}

function defaultViewTemplates() {
  return [
    {
      id: 'architecture',
      title: 'Architecture',
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

els.connectBtn.addEventListener('click', () => {
  void openProject().catch((error) => {
    setWorkspaceStatus(error.message)
    appendLog('Open Workspace Failed', error.message, 'error')
  })
})

els.saveWorkspaceBtn.addEventListener('click', () => {
  if (state.activeTopTab === 'view') updateActiveViewFromEditor()
  void saveWorkspace('workspace-save').catch((error) => {
    setWorkspaceStatus(error.message)
    appendLog('Save Failed', error.message, 'error')
  })
})

els.viewModeBtn.addEventListener('click', () => {
  if (state.activeTopTab !== 'view') return
  updateActiveViewFromEditor()
  setDiagramMode('view')
  renderWorkspace()
})

els.editModeBtn.addEventListener('click', () => {
  if (state.activeTopTab !== 'view') return
  setDiagramMode('edit')
  renderWorkspace()
  setWorkspaceStatus('Edit mode shows the raw Mermaid so you can update it directly.')
})

els.diagramEditor.addEventListener('input', () => {
  state.previewMermaid = els.diagramEditor.value
  els.viewMermaid.value = els.diagramEditor.value
})

els.previewBtn.addEventListener('click', () => {
  updateActiveViewFromEditor()
  renderWorkspace()
  setWorkspaceStatus('Preview updated locally. Save when the view looks right.')
})

els.saveViewBtn.addEventListener('click', () => {
  updateActiveViewFromEditor()
  renderWorkspace()
  void saveWorkspace(`save-${state.activeViewId || 'view'}`).catch((error) => {
    setWorkspaceStatus(error.message)
    appendLog('Save Failed', error.message, 'error')
  })
})

els.resetExampleBtn.addEventListener('click', () => {
  resetActiveView()
})

els.authForm.addEventListener('submit', (event) => {
  event.preventDefault()
  const username = els.authUsername.value.trim()
  const password = els.authPassword.value
  void login(username, password)
    .then(() => {
      setWorkspaceStatus('Signed in to Delma.')
      appendLog('Signed In', 'Delma unlocked. Your workspace and memory tools are now available.')
    })
    .catch((error) => {
      els.authError.textContent = error.message
    })
})

els.logoutBtn.addEventListener('click', () => {
  void logout().then(() => {
    setWorkspaceStatus('Signed out.')
    appendLog('Signed Out', 'This Delma workspace is locked until you sign in again.')
  })
})

async function init() {
  setOpenState(false)
  state.activeViewId = starterTemplates[0].id
  state.documentationContent = buildDocumentationPreview({ views: starterTemplates }, {})
  els.input.value = 'Claude Code is now the primary chat surface. Delma runs beside it as a workspace + MCP server.'
  renderWorkspace()
  appendLog(
    'Delma Is The Sidecar Now',
    [
      'Claude Code should stay your main coding surface.',
      'Delma keeps the diagrams, memory files, history, credentials context, and High Level Documentation in sync.',
      'Run the Delma MCP server with `npm run start:mcp` and point Claude Code at it.'
    ].join('\n')
  )

  await checkAuth()

  if (hostedPreviewMode) {
    state.workspace = {
      projectName: 'Delma',
      updatedAt: new Date().toISOString(),
      views: starterTemplates.map((view) => ({ ...view }))
    }
    state.memory = {
      'environment.md': '# Environment\n\nDelma workspace for SFMC, Salesforce CRM, and optional local assets.\n',
      'logic.md': '# Logic\n\nClaude Code is the main worker. Delma is the shared operational memory sidecar.\n',
      'people.md': '# People\n\nBuilt first around David’s SFMC workflow and shared stakeholder visibility.\n',
      'session-log.md': '# Session Log\n\nWorkspace loaded.\n'
    }
    state.history = ['preview-snapshot--delma-v1.json']
    state.activeViewId = state.workspace.views[0].id
    state.previewMermaid = state.workspace.views[0].mermaid
    state.documentationContent = buildDocumentationPreview(state.workspace, state.memory)
    setActivity('Delma is available here as the shared workspace shell. The full sidecar behavior runs locally with Claude Code.')
    setWorkspaceStatus(state.authEnabled && !state.authenticated ? 'Sign in to open this Delma workspace.' : 'Workspace ready.')
    renderWorkspace()
  }
}

void init()
