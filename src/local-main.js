// Local-mode entry point. Pure wiring: pull DOM refs, initialize each
// focused module (picker / workspace / editor / chat / email), and
// route state transitions between them. No rendering logic lives here.

import { initPicker } from './local/picker.js'
import { initWorkspace } from './local/workspace.js'
import { initChat } from './local/chat.js'
import { initEmailModal } from './email-modal.js'

initEmailModal()

const els = {
  workspace:      document.getElementById('workspace'),
  picker:         document.getElementById('picker'),
  pathInput:      document.getElementById('pathInput'),
  openBtn:        document.getElementById('openBtn'),
  pickerError:    document.getElementById('pickerError'),
  recentList:     document.getElementById('recentList'),
  folderPath:     document.getElementById('folderPath'),
  tabs:           document.getElementById('tabs'),
  pane:           document.getElementById('pane'),
  editBar:        document.getElementById('editBar'),
  editToggleBtn:  document.getElementById('editToggleBtn'),
  editStatus:     document.getElementById('editStatus'),
  chatHost:       document.getElementById('chatHost'),
  chatMessages:   document.getElementById('chatMessages'),
  chatInput:      document.getElementById('chatInput'),
  chatSendBtn:    document.getElementById('chatSendBtn'),
  chatClearBtn:   document.getElementById('chatClearBtn'),
  openEmailBtn:   document.getElementById('openEmailBtn')
}

// Single source of truth for "what project is open right now." Modules
// read this via closures, never import it directly — keeps them simple
// to unit-test with fake state.
const state = { path: null, name: null, summary: null, sections: {} }

// Refetch CLAUDE.md from disk (after a suggestion was applied, after
// a save, after external edit) and re-render the active pane.
async function refreshSectionsFromDisk() {
  if (!state.path) return
  try {
    const res = await fetch(`/api/local/open?path=${encodeURIComponent(state.path)}`)
    const data = await res.json()
    if (!res.ok) return
    state.sections = data.sections
    await workspace.renderActivePane()
  } catch { /* non-fatal — next refresh will pick it up */ }
}

// Write one section back to CLAUDE.md. Called from the editor when the
// user clicks Save.
async function saveSection(sectionKey, newContent) {
  const res = await fetch('/api/local/save', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ path: state.path, sections: { [sectionKey]: newContent } })
  })
  const data = await res.json()
  if (!res.ok) throw new Error(data.error || 'save failed')
  state.sections[sectionKey] = newContent
}

const workspace = initWorkspace({
  els,
  getState: () => state,
  saveSection
})

const chat = initChat({
  els,
  getPath: () => state.path,
  onDocUpdated: refreshSectionsFromDisk
})

const picker = initPicker({
  els,
  onOpen: async (doc) => {
    state.path = doc.path
    state.name = doc.name
    state.summary = doc.summary
    state.sections = doc.sections || {}
    await workspace.show({ path: doc.path, name: doc.name })
    await chat.load()
  }
})

// Email builder button — opens the existing React-free modal. The modal
// detects local mode automatically (no projectId set) and uses
// /api/local/emails/create.
els.openEmailBtn.addEventListener('click', () => {
  if (typeof window.delmaOpenEmailModal === 'function') window.delmaOpenEmailModal()
  else alert('Email builder not loaded yet.')
})

// Boot: if ?path=/some/folder is in the URL, auto-open; otherwise the
// picker shows its recent-folders list and waits for input.
async function boot() {
  const params = new URLSearchParams(window.location.search)
  const urlPath = params.get('path')
  if (urlPath) { await picker.tryOpen(urlPath); return }
  await picker.loadRecent()
}

boot().catch(err => console.error('[local] boot failed:', err))
