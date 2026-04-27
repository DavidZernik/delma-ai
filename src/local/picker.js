// Folder picker screen: recent-list + path input. Hands off to the
// workspace module on Open. Self-contained: renders into its own hosts
// and emits a single callback when a folder is selected.
//
// When the user opens a path that doesn't have a CLAUDE.md AND has 2+
// siblings that do, the server returns { needsSeed: true, siblings }.
// We render an inline prompt asking which sibling to inherit shared
// sections from (or "start blank"), then re-call open with `inheritFrom`.

import { escapeHtml, escapeAttr } from './util.js'

export function initPicker({ els, onOpen }) {
  els.openBtn.addEventListener('click', () => {
    const v = els.pathInput.value.trim()
    if (v) tryOpen(v)
  })
  els.pathInput.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') els.openBtn.click()
  })

  // `inheritFrom` semantics:
  //   undefined   — no decision yet; server may respond with needsSeed
  //   ''          — user explicitly chose blank starter; server seeds blank
  //   '/abs/path' — user picked a sibling; server copies its shared sections
  async function tryOpen(path, inheritFrom) {
    showError(null)
    try {
      const params = new URLSearchParams({ path })
      if (inheritFrom !== undefined) params.set('inheritFrom', inheritFrom)
      const res = await fetch(`/api/local/open?${params}`)
      const data = await res.json()
      if (!res.ok) { showError(data.error || 'Failed to open'); return }
      if (data.needsSeed) { showSeedPrompt(path, data.siblings || []); return }
      onOpen(data)
    } catch (err) { showError(err.message) }
  }

  function showError(msg) {
    els.pickerError.innerHTML = msg ? `<div class="error-banner">${escapeHtml(msg)}</div>` : ''
  }

  function showSeedPrompt(targetPath, siblings) {
    const targetName = targetPath.split('/').filter(Boolean).pop() || targetPath
    const siblingButtons = siblings.map(s => `
      <button class="seed-pick" data-path="${escapeAttr(s.path)}">
        <div class="seed-pick-name">${escapeHtml(s.name)}</div>
        <div class="seed-pick-path">${escapeHtml(s.path)}</div>
      </button>
    `).join('')
    els.pickerError.innerHTML = `
      <div class="seed-prompt">
        <div class="seed-prompt-head">
          New project <strong>${escapeHtml(targetName)}</strong>. Copy <em>General Notes</em> and <em>File Locations and Keys</em> from?
        </div>
        <div class="seed-prompt-list">
          ${siblingButtons}
          <button class="seed-pick seed-pick-blank" data-path="">
            <div class="seed-pick-name">Start blank</div>
            <div class="seed-pick-path">Don't copy anything from a sibling</div>
          </button>
        </div>
      </div>`
    for (const btn of els.pickerError.querySelectorAll('.seed-pick')) {
      btn.addEventListener('click', () => tryOpen(targetPath, btn.dataset.path))
    }
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
