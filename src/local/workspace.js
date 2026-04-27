// The three-tab workspace: renders the active section of CLAUDE.md via the
// diagram module (which handles mermaid + click-to-reveal node modals when
// a "### Step descriptions" subsection is present), and hands off to the
// editor when the user clicks Edit. Holds no data beyond the sections it
// was given — parent owns state.

import { marked } from 'marked'
import { escapeHtml } from './util.js'
import { initEditor } from './editor.js'
import { renderSection } from './diagram.js'
import { initSfmcTab } from './sfmc-tab.js'

marked.setOptions({ breaks: true, gfm: true })

// Most tabs are slices of the project's CLAUDE.md (one ## heading per tab).
// "Connections and Passwords" is the exception: its data lives in
// machine-local config files (~/.config/sfmc/.env, future ~/.config/<platform>/)
// because credentials belong to the machine, not the project. Tab UI is
// identical; the renderer just sources from a different place. Today it
// only knows SFMC; future platforms will compose into the same tab.
const TAB_ORDER = [
  { key: 'projectDetails',  label: 'Project Details' },
  { key: 'generalNotes',    label: 'General Notes' },
  { key: 'fileLocations',   label: 'File Locations and Keys' },
  { key: 'connections',     label: 'Connections and Passwords', external: true }
]

export function initWorkspace({ els, getState, saveSection }) {
  let activeTab = 'projectDetails'
  let editing = false

  const sfmcTab = initSfmcTab()

  const editor = initEditor({
    els,
    getCurrent: () => getState().sections[activeTab] || '',
    onSave: async (newContent) => {
      editing = false
      await saveSection(activeTab, newContent)
      await renderActivePane()
    },
    onCancel: async () => { editing = false; await renderActivePane() }
  })

  async function show({ path, name }) {
    els.picker.hidden = true
    els.workspace.hidden = false
    els.chatHost.hidden = false
    els.folderPath.textContent = path
    document.title = `${name} — Delma`
    renderTabs()
    await renderActivePane()
  }

  function renderTabs() {
    els.tabs.innerHTML = TAB_ORDER.map(t =>
      `<button class="tab${t.key === activeTab ? ' active' : ''}" data-key="${t.key}">${escapeHtml(t.label)}</button>`
    ).join('')
    for (const btn of els.tabs.querySelectorAll('.tab')) {
      btn.addEventListener('click', async () => {
        if (editing) return // finish saving/cancelling first
        activeTab = btn.dataset.key
        renderTabs()
        await renderActivePane()
      })
    }
  }

  function activeTabDef() {
    return TAB_ORDER.find(t => t.key === activeTab) || TAB_ORDER[0]
  }

  async function renderActivePane() {
    const def = activeTabDef()
    // External-data tabs (SFMC Connections) have their own in-card edit
    // affordances, so the workspace-level Edit/Save bar is hidden for them.
    if (def.external) {
      editing = false
      els.editBar.hidden = true
      els.editStatus.textContent = ''
      if (def.key === 'connections') await sfmcTab.render(els.pane)
      return
    }
    els.editBar.hidden = false
    els.editToggleBtn.textContent = editing ? 'Cancel' : 'Edit'
    els.editStatus.textContent = ''
    if (editing) { editor.paint(); return }
    const content = getState().sections[activeTab] || ''
    if (!content.trim() || content.trim() === '_(empty)_') {
      els.pane.innerHTML = `<p class="empty-hint">This section is empty. Click Edit to add content, or chat with Delma to have it propose updates.</p>`
      return
    }
    await renderSection(els.pane, content)
  }

  els.editToggleBtn.addEventListener('click', async () => {
    editing = !editing
    if (editing) editor.paint()
    else await renderActivePane()
  })

  return { show, renderActivePane, getActiveTab: () => activeTab }
}
