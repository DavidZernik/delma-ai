// Folder picker screen: recent-list + path input. Hands off to the
// workspace module on Open. Self-contained: renders into its own hosts
// and emits a single callback when a folder is selected.

import { escapeHtml, escapeAttr } from './util.js'

export function initPicker({ els, onOpen }) {
  els.openBtn.addEventListener('click', () => {
    const v = els.pathInput.value.trim()
    if (v) tryOpen(v)
  })
  els.pathInput.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') els.openBtn.click()
  })

  async function tryOpen(path) {
    showError(null)
    try {
      const res = await fetch(`/api/local/open?path=${encodeURIComponent(path)}`)
      const data = await res.json()
      if (!res.ok) { showError(data.error || 'Failed to open'); return }
      onOpen(data)
    } catch (err) { showError(err.message) }
  }

  function showError(msg) {
    els.pickerError.innerHTML = msg ? `<div class="error-banner">${escapeHtml(msg)}</div>` : ''
  }

  async function loadRecent() {
    try {
      const res = await fetch('/api/local/recent')
      const data = await res.json()
      renderRecent(data.items || [])
    } catch { /* silent — no recent list is fine */ }
  }

  function renderRecent(items) {
    if (!items.length) { els.recentList.innerHTML = ''; return }
    const rows = items.map(it => `
      <button class="recent-item" data-path="${escapeAttr(it.path)}">
        <div class="recent-item-name">${escapeHtml(it.name)}</div>
        <div class="recent-item-path">${escapeHtml(it.path)}</div>
      </button>
    `).join('')
    els.recentList.innerHTML = `<h3>Recent</h3>${rows}`
    for (const btn of els.recentList.querySelectorAll('.recent-item')) {
      btn.addEventListener('click', () => tryOpen(btn.dataset.path))
    }
  }

  return { tryOpen, loadRecent }
}
