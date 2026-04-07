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
  projectDir: '',
  workspace: null,
  graph: null,
  memory: {},
  history: [],
  activeViewId: null,
  previewMermaid: ''
}

const hostedPreviewMode = window.location.hostname.endsWith('.vercel.app')

const els = {
  projectDir: document.getElementById('project-dir'),
  connectBtn: document.getElementById('connect-btn'),
  sdkStatus: document.getElementById('sdk-status'),
  statusDot: document.getElementById('status-dot'),
  activityRail: document.getElementById('activity-rail'),
  sdkBody: document.getElementById('sdk-body'),
  input: document.getElementById('input'),
  sendBtn: document.getElementById('send-btn'),
  composeBtn: document.getElementById('compose-btn'),
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
  workspaceStatus: document.getElementById('workspace-status'),
  projectPill: document.getElementById('project-pill'),
  historyPill: document.getElementById('history-pill'),
  diagramToolbarTitle: document.getElementById('diagram-toolbar-title'),
  diagramToolbarSubtitle: document.getElementById('diagram-toolbar-subtitle'),
  diagramOutput: document.getElementById('diagram-output'),
  viewTitleInput: document.getElementById('view-title-input'),
  viewDescriptionInput: document.getElementById('view-description-input'),
  viewSummaryInput: document.getElementById('view-summary-input'),
  viewMermaid: document.getElementById('view-mermaid'),
  saveNote: document.getElementById('save-note')
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

function setOpenState(isOpen) {
  els.sdkStatus.textContent = hostedPreviewMode
    ? 'Hosted Preview'
    : isOpen
      ? 'Project Open'
      : 'Waiting For Project'
  els.statusDot.className = `dot${isOpen || hostedPreviewMode ? ' connected' : ''}`
  els.connectBtn.textContent = hostedPreviewMode
    ? 'Runs Locally'
    : isOpen
      ? 'Reload Project'
      : 'Open Project'
  els.input.disabled = true
  els.sendBtn.disabled = true
}

function getActiveView() {
  return state.workspace?.views?.find((view) => view.id === state.activeViewId) || state.workspace?.views?.[0] || null
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

function renderViewTabs() {
  const views = state.workspace?.views || []
  els.viewTabs.textContent = ''

  if (!views.length) {
    els.viewTabs.innerHTML = '<div class="history-item">No diagram tabs yet.</div>'
    return
  }

  for (const view of views) {
    const button = document.createElement('button')
    button.className = `view-tab${view.id === state.activeViewId ? ' active' : ''}`
    button.innerHTML = `
      <div class="view-tab-title">${escapeHtml(view.title)}</div>
      <div class="view-tab-copy">${escapeHtml(view.description || 'No description yet.')}</div>
    `
    button.addEventListener('click', () => {
      state.activeViewId = view.id
      state.previewMermaid = view.mermaid || ''
      renderWorkspace()
    })
    els.viewTabs.appendChild(button)
  }
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

function renderWorkspace() {
  renderViewTabs()
  renderHistory()
  renderMemory()

  const view = getActiveView()
  if (!view) {
    els.workspaceTitle.textContent = 'Delma Workspace'
    els.workspaceCopy.textContent = 'Open a project to load Delma memory and diagram tabs.'
    els.viewTitle.textContent = 'No active view'
    els.viewDescription.textContent = ''
    els.viewSummary.textContent = ''
    populateEditor(null)
    void renderDiagram('')
    return
  }

  els.workspaceTitle.textContent = state.workspace?.projectName ? `${state.workspace.projectName} Workspace` : 'Delma Workspace'
  els.workspaceCopy.textContent = 'Claude Code is the worker. Delma is the visual memory sidecar that Claude can update while it works.'
  els.viewTitle.textContent = view.title
  els.viewDescription.textContent = view.description || 'No description yet.'
  els.viewSummary.textContent = view.summary || 'No summary yet.'
  els.projectPill.textContent = state.projectDir || 'No project connected'
  els.historyPill.textContent = `${state.history.length} snapshots`
  els.diagramToolbarTitle.textContent = view.title
  els.diagramToolbarSubtitle.textContent = view.kind ? `${view.kind} view` : 'Mermaid view'
  els.saveNote.textContent = 'Claude Code should update these views through the Delma MCP server. Manual edits here stay versioned too.'
  populateEditor(view)
  void renderDiagram(state.previewMermaid || view.mermaid || '')
}

async function refreshWorkspace() {
  if (!state.projectDir) return
  const response = await fetch('/api/delma/state')
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
  renderWorkspace()
}

async function saveWorkspace(reason = 'workspace-save') {
  if (!state.workspace) return
  const response = await fetch('/api/delma/workspace', {
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
  appendLog('Workspace Saved', `Snapshot ${data.snapshotFile} written and CLAUDE.md recomposed.`)
}

function updateActiveViewFromEditor() {
  const view = getActiveView()
  if (!view) return
  view.title = els.viewTitleInput.value.trim() || view.title
  view.description = els.viewDescriptionInput.value.trim()
  view.summary = els.viewSummaryInput.value.trim()
  view.mermaid = els.viewMermaid.value
  state.previewMermaid = view.mermaid
}

async function openProject() {
  if (hostedPreviewMode) {
    setWorkspaceStatus('This hosted build is a Delma preview. The full sidecar workflow runs locally beside Claude Code.')
    setActivity('Hosted preview mode: Delma is deployed here as a shareable shell. Run it locally for MCP, project files, and live CLAUDE.md updates.')
    appendLog(
      'Hosted Preview',
      [
        'This Vercel deployment is a shareable Delma preview.',
        'The real Delma sidecar still runs locally on your machine.',
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
  setActivity('Opening the local Delma workspace and recomposing CLAUDE.md...')
  const response = await fetch('/api/project/open', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ projectDir: dir })
  })
  const data = await response.json()
  if (!response.ok) throw new Error(data.error || 'Unable to open project')

  setOpenState(true)
  await refreshWorkspace()
  setWorkspaceStatus('Project opened locally. Claude Code can now connect to Delma via MCP.')
  setActivity('Delma is ready. Run the MCP server and let Claude Code call it while you work.')
  appendLog(
    'How Delma Fits',
    [
      '1. Keep working in Claude Code.',
      '2. Run `npm run start:mcp` in this repo.',
      '3. Add the Delma server from `.mcp.json.example` to your Claude Code MCP config.',
      '4. Claude can now read and update these diagram tabs plus CLAUDE.md.'
    ].join('\n')
  )
}

async function composeClaudeMd() {
  const response = await fetch('/api/memory/compose', { method: 'POST' })
  const data = await response.json()
  if (!response.ok) throw new Error(data.error || 'Unable to compose CLAUDE.md')
  setWorkspaceStatus(`Composed CLAUDE.md (${data.length} chars)`)
  appendLog('CLAUDE.md Updated', `Regenerated from the Delma workspace and memory files. Length: ${data.length} chars.`)
}

function resetActiveView() {
  const currentId = state.activeViewId
  if (!currentId) return
  const template = starterTemplates.find((view) => view.id === currentId)
  if (!template) return
  const view = getActiveView()
  Object.assign(view, template)
  state.previewMermaid = view.mermaid
  renderWorkspace()
  setWorkspaceStatus(`Reset ${view.title} to the Delma starter layout.`)
}

function defaultViewTemplates() {
  return [
    {
      id: 'codebase',
      title: 'Codebase',
      description: 'Core app surfaces, runtime layers, and memory pipeline.',
      summary: 'The local app wraps Claude, persists project memory, and renders diagrams from Delma workspace state.',
      mermaid: `---
config:
  look: neo
  theme: neo
  layout: elk
---
flowchart LR
  Claude["Claude Code"] --> MCP["Delma MCP Server"]
  MCP --> Workspace["workspace.json"]
  MCP --> History[".delma/history"]
  MCP --> Compose["CLAUDE.md"]
  Workspace --> Views["Tabbed Mermaid Views"]
  Views --> UI["Delma UI"]
`
    },
    {
      id: 'org',
      title: 'Org',
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
      description: 'How information moves through SFMC systems and local tooling.',
      summary: 'Use this for journeys, data extensions, APIs, and any operational flow you need to reason about quickly.',
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
      description: 'A focused working map for the task in front of you right now.',
      summary: 'Keep this intentionally small. It should answer what matters in the current coding session.',
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

els.connectBtn.addEventListener('click', () => {
  void openProject().catch((error) => {
    setWorkspaceStatus(error.message)
    appendLog('Open Project Failed', error.message, 'error')
  })
})

els.composeBtn.addEventListener('click', () => {
  void composeClaudeMd().catch((error) => {
    setWorkspaceStatus(error.message)
    appendLog('Compose Failed', error.message, 'error')
  })
})

els.saveWorkspaceBtn.addEventListener('click', () => {
  void saveWorkspace('workspace-save').catch((error) => {
    setWorkspaceStatus(error.message)
    appendLog('Save Failed', error.message, 'error')
  })
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

setOpenState(false)
els.input.value = 'Claude Code is now the primary chat surface. Delma runs beside it as a workspace + MCP server.'
renderWorkspace()
appendLog(
  'Delma Is The Sidecar Now',
  [
    'Claude Code should stay your main coding surface.',
    'Delma keeps the diagrams, memory files, history, and CLAUDE.md in sync.',
    'Run the Delma MCP server with `npm run start:mcp` and point Claude Code at it.'
  ].join('\n')
)

if (hostedPreviewMode) {
  state.workspace = {
    projectName: 'Delma',
    updatedAt: new Date().toISOString(),
    views: starterTemplates.map((view) => ({ ...view }))
  }
  state.memory = {
    'environment.md': '# Environment\n\nHosted preview for Delma V1.\n',
    'logic.md': '# Logic\n\nClaude Code is the main worker. Delma is the visual memory sidecar.\n',
    'people.md': '# People\n\nBuilt first around David’s SFMC workflow.\n',
    'session-log.md': '# Session Log\n\nHosted preview loaded.\n'
  }
  state.history = ['preview-snapshot--delma-v1.json']
  state.activeViewId = state.workspace.views[0].id
  state.previewMermaid = state.workspace.views[0].mermaid
  setActivity('Hosted preview mode: Delma is deployed here as a shareable workspace shell. The real sidecar behavior runs locally with Claude Code.')
  setWorkspaceStatus('Hosted preview ready.')
  renderWorkspace()
}
