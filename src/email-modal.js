// "New Email" modal — step-by-step SFMC 207 email builder.
//
// Entry point: `window.delmaOpenEmailModal()` opens the modal. Intended to
// be called from the chat sidebar button. Everything else is internal.
//
// Flow:
//   Step 1: Pick blocks from the library
//   Step 2: Fill content for each picked block
//   Step 3: Subject line (preheader optional — user edits in SFMC)
//   Step 4: Pick a folder
//   Step 5: Review + Create
//   After: success state with asset ID + "Open in SFMC" link
//
// The modal is driven by a single `state` object and a `render()` dispatcher
// that paints the current step into #email-modal-body. Each step is a pure
// function from state → HTML + event wiring.

import { supabase } from './lib/supabase.js'

const STEPS = ['blocks', 'content', 'subject', 'folder', 'review']
const STEP_LABELS = {
  blocks: 'Pick your blocks',
  content: 'Fill in content',
  subject: 'Subject line',
  folder: 'Pick a folder',
  review: 'Review & create'
}

const state = {
  open: false,
  stepIndex: 0,
  library: null,        // { blocks, baseTemplate } from /api/email-library
  folders: null,        // [{ id, name, parentId }, ...] from SFMC
  picked: [],           // [{ id: 'HB10', vars: { headline: '...', ... } }]
  name: '',
  subject: '',
  preheader: '',
  categoryId: null,
  submitting: false,
  result: null,         // { ok, assetId, deepLink, error? }
  projectId: null
}

const els = {}

export function initEmailModal() {
  els.modal = document.getElementById('email-modal')
  els.body = document.getElementById('email-modal-body')
  els.stepLabel = document.getElementById('email-modal-step-label')
  els.close = document.getElementById('email-modal-close')
  els.back = document.getElementById('email-modal-back')
  els.next = document.getElementById('email-modal-next')
  els.cancel = document.getElementById('email-modal-cancel')
  if (!els.modal) { console.warn('[email-modal] DOM elements not found — skipping init'); return }

  els.close.addEventListener('click', closeModal)
  els.cancel.addEventListener('click', closeModal)
  els.modal.querySelector('.email-modal-backdrop')?.addEventListener('click', closeModal)
  els.back.addEventListener('click', stepBack)
  els.next.addEventListener('click', stepNext)

  document.addEventListener('keydown', (ev) => {
    if (!state.open) return
    if (ev.key === 'Escape') closeModal()
  })

  window.delmaOpenEmailModal = openModal
}

async function openModal(opts = {}) {
  state.open = true
  state.stepIndex = 0
  state.library = null
  state.folders = null
  state.picked = []
  state.name = ''
  state.subject = ''
  state.preheader = ''
  state.categoryId = null
  state.submitting = false
  state.result = null
  state.projectId = opts.projectId || window.delmaState?.projectId || window.__delmaProjectId || null

  els.modal.hidden = false
  paintLoading('Loading your block library…')

  try {
    const lib = await fetchJSON('/api/email-library')
    state.library = lib
    // Kick off folders fetch in parallel — it's slow and only needed at step 4.
    if (state.projectId) {
      fetchJSON(`/api/projects/${state.projectId}/sfmc/folders`)
        .then(f => { state.folders = f.folders || [] })
        .catch(err => { state.folders = { error: err.message } })
    }
    render()
  } catch (err) {
    paintError(`Failed to load block library: ${err.message}`)
  }
}

function closeModal() {
  state.open = false
  els.modal.hidden = true
}

function stepBack() {
  if (state.result) { closeModal(); return }
  if (state.stepIndex > 0) { state.stepIndex -= 1; render() }
}

function stepNext() {
  if (state.result) { closeModal(); return }
  const err = validateStep(STEPS[state.stepIndex])
  if (err) { alert(err); return }
  if (state.stepIndex < STEPS.length - 1) { state.stepIndex += 1; render(); return }
  // Last step — submit.
  submit()
}

function validateStep(step) {
  if (step === 'blocks' && state.picked.length === 0) return 'Pick at least one block to continue.'
  if (step === 'content') {
    // All user-facing text fields must be non-empty unless they have a default.
    for (const p of state.picked) {
      const def = state.library.blocks.find(b => b.id === p.id)
      for (const v of def.variables) {
        const val = p.vars[v.key]
        if (val === '' || val === undefined) {
          // Allow fields with defaults to stay on default.
          if (v.default !== undefined && v.default !== '') continue
          return `Fill in "${v.label}" for ${def.name}.`
        }
      }
    }
  }
  if (step === 'subject') {
    if (!state.name.trim()) return 'Email name is required (used in Content Builder).'
    if (!state.subject.trim()) return 'Subject line is required.'
  }
  if (step === 'folder' && !state.categoryId) return 'Pick a folder to continue.'
  return null
}

function render() {
  const step = STEPS[state.stepIndex]
  els.stepLabel.textContent = `Step ${state.stepIndex + 1} of ${STEPS.length} · ${STEP_LABELS[step]}`
  els.back.style.visibility = state.stepIndex === 0 ? 'hidden' : 'visible'
  els.next.textContent = state.stepIndex === STEPS.length - 1 ? 'Create in SFMC' : 'Next →'
  els.next.disabled = false

  if (step === 'blocks') renderStepBlocks()
  else if (step === 'content') renderStepContent()
  else if (step === 'subject') renderStepSubject()
  else if (step === 'folder') renderStepFolder()
  else if (step === 'review') renderStepReview()
}

function renderStepBlocks() {
  const pickedIds = state.picked.map(p => p.id)
  const cards = state.library.blocks.map(b => {
    const order = pickedIds.indexOf(b.id) + 1
    const selected = order > 0
    return `
      <div class="email-block-card${selected ? ' selected' : ''}" data-block="${b.id}">
        ${selected ? `<div class="email-block-card-badge">${order}</div>` : ''}
        <div class="email-block-card-id">${b.id}</div>
        <div class="email-block-card-name">${escapeHtml(b.name)}</div>
        <div class="email-block-card-desc">${escapeHtml(b.description || '')}</div>
      </div>
    `
  }).join('')

  const pickedList = state.picked.length
    ? `
      <div class="email-block-picked">
        <div class="email-block-picked-header">Picked · in order</div>
        <div class="email-block-picked-list">
          ${state.picked.map((p, i) => {
            const def = state.library.blocks.find(b => b.id === p.id)
            return `
              <div class="email-block-picked-row">
                <span class="email-block-picked-order">${i + 1}.</span>
                <span class="email-block-picked-name">${def.id} · ${escapeHtml(def.name)}</span>
                <button class="email-block-picked-remove" data-remove="${p.id}" title="Remove">×</button>
              </div>
            `
          }).join('')}
        </div>
      </div>
    ` : ''

  els.body.innerHTML = `
    <p style="font-size:13px;color:var(--ink-secondary);margin:0 0 16px;">
      Click blocks in the order you want them stacked in the email. Click again to remove.
    </p>
    <div class="email-block-grid">${cards}</div>
    ${pickedList}
  `

  els.body.querySelectorAll('[data-block]').forEach(el => {
    el.addEventListener('click', () => toggleBlock(el.dataset.block))
  })
  els.body.querySelectorAll('[data-remove]').forEach(el => {
    el.addEventListener('click', (ev) => {
      ev.stopPropagation()
      state.picked = state.picked.filter(p => p.id !== el.dataset.remove)
      render()
    })
  })
}

function toggleBlock(id) {
  const existing = state.picked.findIndex(p => p.id === id)
  if (existing >= 0) {
    state.picked.splice(existing, 1)
  } else {
    const def = state.library.blocks.find(b => b.id === id)
    const vars = {}
    for (const v of def.variables) vars[v.key] = v.default ?? ''
    state.picked.push({ id, vars })
  }
  render()
}

function renderStepContent() {
  if (state.picked.length === 0) {
    els.body.innerHTML = `<div class="email-empty-state">No blocks picked. Go back to Step 1.</div>`
    return
  }
  const blocks = state.picked.map(p => {
    const def = state.library.blocks.find(b => b.id === p.id)
    const fields = def.variables.map(v => renderField(p, v)).join('')
    return `
      <div class="email-content-block">
        <div class="email-content-block-header">
          <span class="email-content-block-badge">${def.id}</span>
          <span class="email-content-block-title">${escapeHtml(def.name)}</span>
        </div>
        ${fields}
      </div>
    `
  }).join('')
  els.body.innerHTML = `
    <p style="font-size:13px;color:var(--ink-secondary);margin:0 0 16px;">
      Fill in each block. Leave defaults where they work.
    </p>
    ${blocks}
  `
  els.body.querySelectorAll('[data-var]').forEach(el => {
    el.addEventListener('input', () => {
      const [blockIdx, key] = el.dataset.var.split('::')
      state.picked[Number(blockIdx)].vars[key] = el.value
    })
  })
}

function renderField(picked, v) {
  const blockIdx = state.picked.indexOf(picked)
  const val = picked.vars[v.key] ?? v.default ?? ''
  const common = `data-var="${blockIdx}::${v.key}"`
  if (v.type === 'textarea') {
    return `
      <div class="email-field">
        <label>${escapeHtml(v.label)}</label>
        <textarea ${common} rows="2">${escapeHtml(val)}</textarea>
      </div>
    `
  }
  if (v.type === 'color') {
    return `
      <div class="email-field">
        <label>${escapeHtml(v.label)}</label>
        <input type="color" ${common} value="${escapeHtml(val)}" />
      </div>
    `
  }
  return `
    <div class="email-field">
      <label>${escapeHtml(v.label)}</label>
      <input type="${v.type === 'url' ? 'url' : 'text'}" ${common} value="${escapeHtml(val)}" />
    </div>
  `
}

function renderStepSubject() {
  els.body.innerHTML = `
    <p style="font-size:13px;color:var(--ink-secondary);margin:0 0 16px;">
      Name the email (used in Content Builder) and write the subject line shown in recipients' inboxes.
      Preheader is optional — you can edit it directly in SFMC after creation.
    </p>
    <div class="email-field">
      <label>Email name (Content Builder label)</label>
      <input type="text" id="email-name-field" value="${escapeHtml(state.name)}" placeholder="e.g. cardio_may2026_openhouse" />
    </div>
    <div class="email-field">
      <label>Subject line</label>
      <input type="text" id="email-subject-field" value="${escapeHtml(state.subject)}" placeholder="e.g. Join us May 18 — Heart and Vascular Open House" />
    </div>
    <div class="email-field">
      <label>Preheader (optional)</label>
      <input type="text" id="email-preheader-field" value="${escapeHtml(state.preheader)}" placeholder="Short preview text — or leave blank and edit in SFMC" />
    </div>
  `
  document.getElementById('email-name-field').addEventListener('input', (ev) => { state.name = ev.target.value })
  document.getElementById('email-subject-field').addEventListener('input', (ev) => { state.subject = ev.target.value })
  document.getElementById('email-preheader-field').addEventListener('input', (ev) => { state.preheader = ev.target.value })
}

function renderStepFolder() {
  if (state.folders === null) {
    els.body.innerHTML = `<div class="email-empty-state">Loading your Content Builder folders…</div>`
    // Re-render when folders arrive.
    const poll = setInterval(() => {
      if (state.folders !== null) { clearInterval(poll); if (state.open && STEPS[state.stepIndex] === 'folder') render() }
    }, 300)
    return
  }
  if (state.folders.error) {
    els.body.innerHTML = `<div class="email-empty-state" style="color:var(--accent);">Failed to load folders: ${escapeHtml(state.folders.error)}</div>`
    return
  }
  const folders = state.folders.filter(f => f && (f.path === 'asset' || !f.path))
  const rows = folders.map(f => `
    <div class="email-folder-row${f.id === state.categoryId ? ' selected' : ''}" data-folder="${f.id}">
      <span class="email-folder-icon">📁</span>
      <span>${escapeHtml(f.name)}</span>
      <span style="flex:1;"></span>
      <span style="font-family:var(--mono);font-size:11px;color:var(--muted);">${f.id}</span>
    </div>
  `).join('')
  els.body.innerHTML = `
    <p style="font-size:13px;color:var(--ink-secondary);margin:0 0 12px;">
      Pick the Content Builder folder where this email should live.
    </p>
    <div class="email-folder-list">${rows || '<div class="email-empty-state">No folders found.</div>'}</div>
  `
  els.body.querySelectorAll('[data-folder]').forEach(el => {
    el.addEventListener('click', () => {
      state.categoryId = Number(el.dataset.folder)
      render()
    })
  })
}

function renderStepReview() {
  const folder = (state.folders || []).find(f => f.id === state.categoryId)
  const blocksSummary = state.picked.map((p, i) => {
    const def = state.library.blocks.find(b => b.id === p.id)
    return `${i + 1}. ${def.id} · ${def.name}`
  }).join('<br>')

  if (state.submitting) {
    els.body.innerHTML = `
      <div class="email-empty-state">
        <div class="boot-spinner" role="status" style="margin:0 auto 12px;"></div>
        Creating the email in SFMC…
      </div>
    `
    return
  }
  if (state.result?.ok) {
    els.body.innerHTML = `
      <div class="email-success">
        <div class="email-success-badge">✓</div>
        <div class="email-success-title">${escapeHtml(state.result.name || state.name)}</div>
        <div class="email-success-detail">
          Asset ID: ${state.result.assetId} · ${escapeHtml(folder?.name || String(state.categoryId))}
        </div>
        <div class="email-success-actions">
          <a class="email-modal-btn email-modal-btn-primary" href="${state.result.deepLink}" target="_blank" rel="noreferrer" style="text-decoration:none;">Open in SFMC →</a>
          <button class="email-modal-btn email-modal-btn-ghost" id="create-another">Create another</button>
        </div>
      </div>
    `
    document.getElementById('create-another').addEventListener('click', () => { openModal({ projectId: state.projectId }) })
    els.next.style.display = 'none'
    els.back.style.visibility = 'hidden'
    els.cancel.textContent = 'Close'
    return
  }
  if (state.result && !state.result.ok) {
    els.body.innerHTML = `
      <div class="email-empty-state" style="color:var(--accent);">
        <strong>Create failed.</strong><br><br>
        ${escapeHtml(state.result.error || 'Unknown error')}
      </div>
    `
    els.next.textContent = 'Try again'
    return
  }

  els.body.innerHTML = `
    <p style="font-size:13px;color:var(--ink-secondary);margin:0 0 16px;">
      Everything looks good? Hit <strong>Create in SFMC</strong> below.
    </p>
    <div class="email-review-summary">
      <div class="email-review-row">
        <div class="email-review-label">Name</div>
        <div class="email-review-value">${escapeHtml(state.name)}</div>
      </div>
      <div class="email-review-row">
        <div class="email-review-label">Subject</div>
        <div class="email-review-value">${escapeHtml(state.subject)}</div>
      </div>
      ${state.preheader ? `
        <div class="email-review-row">
          <div class="email-review-label">Preheader</div>
          <div class="email-review-value">${escapeHtml(state.preheader)}</div>
        </div>
      ` : ''}
      <div class="email-review-row">
        <div class="email-review-label">Folder</div>
        <div class="email-review-value">${escapeHtml(folder?.name || `ID ${state.categoryId}`)}</div>
      </div>
      <div class="email-review-row">
        <div class="email-review-label">Blocks</div>
        <div class="email-review-value">${blocksSummary}</div>
      </div>
      <div class="email-review-row">
        <div class="email-review-label">Template</div>
        <div class="email-review-value">${escapeHtml(state.library.baseTemplate.name)}</div>
      </div>
    </div>
  `
}

async function submit() {
  if (!state.projectId) { alert('No active project. Open a project first, then try again.'); return }
  state.submitting = true
  state.result = null
  render()
  try {
    const res = await fetchJSON(`/api/projects/${state.projectId}/emails/create`, {
      method: 'POST',
      body: JSON.stringify({
        name: state.name,
        subject: state.subject,
        preheader: state.preheader || '',
        categoryId: state.categoryId,
        templateKey: state.library.baseTemplate.id,
        blocks: state.picked
      })
    })
    state.submitting = false
    state.result = { ok: true, ...res }
  } catch (err) {
    state.submitting = false
    state.result = { ok: false, error: err.message }
  }
  render()
}

async function fetchJSON(path, opts = {}) {
  const { data: { session } } = await supabase.auth.getSession()
  const token = session?.access_token
  const res = await fetch(path, {
    ...opts,
    headers: {
      'Content-Type': 'application/json',
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
      ...(opts.headers || {})
    }
  })
  const text = await res.text()
  let data
  try { data = JSON.parse(text) } catch { data = { error: text } }
  if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`)
  return data
}

function paintLoading(msg) {
  els.body.innerHTML = `<div class="email-empty-state"><div class="boot-spinner" role="status" style="margin:0 auto 12px;"></div>${escapeHtml(msg)}</div>`
}

function paintError(msg) {
  els.body.innerHTML = `<div class="email-empty-state" style="color:var(--accent);">${escapeHtml(msg)}</div>`
}

function escapeHtml(s) {
  return String(s ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;')
}
