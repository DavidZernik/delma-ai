// The four-tab workspace: renders the active section of CLAUDE.md as
// markdown (with Mermaid code blocks turned into inline SVG), and hands
// off to the editor module when the user clicks Edit. Holds no data
// beyond the sections it was given — parent owns state.

import { marked } from 'marked'
import mermaid from 'mermaid'
import { escapeHtml } from './util.js'
import { initEditor } from './editor.js'

marked.setOptions({ breaks: true, gfm: true })
mermaid.initialize({ startOnLoad: false, theme: 'neutral', flowchart: { useMaxWidth: true, curve: 'basis' } })

const TAB_ORDER = [
  { key: 'projectDetails', label: 'Project Details' },
  { key: 'integrations',   label: 'Integrations' },
  { key: 'patterns',       label: 'General Patterns and Docs' },
  { key: 'people',         label: 'People' }
]

export function initWorkspace({ els, getState, saveSection }) {
  let activeTab = 'projectDetails'
  let editing = false

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

  async function renderActivePane() {
    els.editBar.hidden = false
    els.editToggleBtn.textContent = editing ? 'Cancel' : 'Edit'
    els.editStatus.textContent = ''
    if (editing) { editor.paint(); return }
    const content = getState().sections[activeTab] || ''
    if (!content.trim() || content.trim() === '_(empty)_') {
      els.pane.innerHTML = `<p class="empty-hint">This section is empty. Click Edit to add content, or chat with Delma to have it propose updates.</p>`
      return
    }
    els.pane.innerHTML = marked.parse(content)
    await renderMermaidBlocks(els.pane)
  }

  els.editToggleBtn.addEventListener('click', async () => {
    editing = !editing
    if (editing) editor.paint()
    else await renderActivePane()
  })

  // Walk rendered markdown, replace each mermaid code block with an
  // inline-rendered SVG in a card host. Failures log and leave the code
  // visible — better than a silent missing diagram.
  async function renderMermaidBlocks(root) {
    const codeBlocks = root.querySelectorAll('code.language-mermaid')
    let i = 0
    for (const code of codeBlocks) {
      const src = code.textContent
      const id = `mmd-${Date.now()}-${i++}`
      try {
        const { svg } = await mermaid.render(id, src)
        const host = document.createElement('div')
        host.className = 'diagram-host'
        host.innerHTML = svg
        code.closest('pre').replaceWith(host)
      } catch (err) { console.warn('[local] mermaid render failed:', err.message) }
    }
  }

  return { show, renderActivePane, getActiveTab: () => activeTab }
}
