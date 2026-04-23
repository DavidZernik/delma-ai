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
        <div class="email-block-thumb">${renderBlockThumb(b.id)}</div>
        <div class="email-block-card-id">${b.id}</div>
        <div class="email-block-card-name">${escapeHtml(b.name)}</div>
        <div class="email-block-card-desc">${escapeHtml(b.description || '')}</div>
      </div>
    `
  }).join('')

  els.body.innerHTML = `
    <p style="font-size:13px;color:var(--ink-secondary);margin:0 0 16px;">
      Click blocks in the order you want them stacked in the email. Click again to remove.
    </p>
    <div class="email-block-grid">${cards}</div>
  `

  els.body.querySelectorAll('[data-block]').forEach(el => {
    el.addEventListener('click', () => toggleBlock(el.dataset.block))
  })
}

// Schematic block previews — stylized wireframes using the Delma brand
// palette (cream bg, red accent, muted lines). All thumbs share the same
// cream background, line treatment, and button color so cards feel like
// one family rather than four different designs.
//
// Primitives:
//   `imgBox(...)` — dashed rectangle with a picture icon (image placeholder)
//   `textLines(...)` — horizontal bars representing lines of text
//   `cta(...)` — red pill for button
//
// Not pixel-perfect (real block HTML references external images that would
// 404 offline), but conveys each block's layout at a glance.
function renderBlockThumb(blockId) {
  const wrap = 'position:relative;width:100%;aspect-ratio:22/10;background:#FFFEEE;border-radius:6px;overflow:hidden;margin-bottom:10px;border:1px solid var(--line);'

  // SVG picture icon (mountain + sun) — shown inside image placeholders.
  const pictureIcon = `<svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" style="color:var(--muted);opacity:0.7;"><rect x="3" y="5" width="18" height="14" rx="1.5"></rect><circle cx="8.5" cy="10" r="1.5"></circle><path d="M21 17l-5-5-6 6"></path></svg>`

  const imgBox = ({ top, left, width, height }) => `
    <div style="position:absolute;top:${top}%;left:${left}%;width:${width}%;height:${height}%;
                border:1.2px dashed var(--line);border-radius:4px;background:#FFFFFF;
                display:flex;align-items:center;justify-content:center;">
      ${pictureIcon}
    </div>
  `
  // `widths` = array of % widths for each line (varying to look like real text).
  const textLines = ({ top, left, widthContainer, widths, align = 'left' }) => {
    const alignItems = align === 'center' ? 'center' : 'flex-start'
    const lines = widths.map(w =>
      `<div style="width:${w}%;height:1.4px;background:var(--muted);opacity:0.55;border-radius:1px;margin:1.2px 0;"></div>`
    ).join('')
    return `
      <div style="position:absolute;top:${top}%;left:${left}%;width:${widthContainer}%;
                  display:flex;flex-direction:column;align-items:${alignItems};">
        ${lines}
      </div>
    `
  }
  const cta = ({ top, left, align = 'center' }) => {
    const transform = align === 'center' ? 'translateX(-50%)' : 'none'
    return `<div style="position:absolute;top:${top}%;left:${left}%;width:24%;height:11%;
                        background:var(--accent);border-radius:3px;transform:${transform};"></div>`
  }

  if (blockId === 'HB10') {
    // Card Art — colored strip at the top (shown as a wide dashed box),
    // with the card image as a smaller dashed box centered on top of it.
    // Then headline text + centered CTA below the strip.
    return `
      <div style="${wrap}">
        ${imgBox({ top: 6, left: 4, width: 92, height: 42 })}
        ${imgBox({ top: 14, left: 35, width: 30, height: 26 })}
        ${textLines({ top: 56, left: 28, widthContainer: 44, widths: [70, 55], align: 'center' })}
        ${cta({ top: 78, left: 50 })}
      </div>
    `
  }
  if (blockId === 'HB11') {
    // Text with Background Graphic — image fills tile, text overlaid
    // directly on the image (no box behind it, real block doesn't have one).
    return `
      <div style="${wrap}">
        ${imgBox({ top: 6, left: 6, width: 88, height: 88 })}
        <div style="position:absolute;top:22%;left:12%;width:50%;">
          <div style="width:80%;height:1.8px;background:var(--muted);opacity:0.7;margin-bottom:4px;border-radius:1px;"></div>
          <div style="width:60%;height:1.2px;background:var(--muted);opacity:0.5;margin-bottom:3px;border-radius:1px;"></div>
          <div style="width:48%;height:1.2px;background:var(--muted);opacity:0.5;border-radius:1px;"></div>
        </div>
        ${cta({ top: 68, left: 12, align: 'left' })}
      </div>
    `
  }
  if (blockId === 'HB12') {
    // Member Since Ribbon — stacked centered elements: headline text,
    // member name text, Member Since IMAGE (not text), year text.
    return `
      <div style="${wrap}">
        ${textLines({ top: 14, left: 25, widthContainer: 50, widths: [100], align: 'center' })}
        ${textLines({ top: 34, left: 32, widthContainer: 36, widths: [70], align: 'center' })}
        ${imgBox({ top: 52, left: 32, width: 36, height: 18 })}
        ${textLines({ top: 78, left: 38, widthContainer: 24, widths: [60], align: 'center' })}
      </div>
    `
  }
  if (blockId === 'HB14') {
    // Icon with Text — small square image left, text + CTA right.
    return `
      <div style="${wrap}">
        ${imgBox({ top: 22, left: 8, width: 18, height: 48 })}
        ${textLines({ top: 24, left: 32, widthContainer: 58, widths: [70, 45, 30] })}
        ${cta({ top: 70, left: 32, align: 'left' })}
      </div>
    `
  }
  // Unknown — generic fallback.
  return `
    <div style="${wrap}">
      ${textLines({ top: 30, left: 20, widthContainer: 60, widths: [80, 60, 40] })}
      ${cta({ top: 72, left: 50 })}
    </div>
  `
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
        <div class="email-content-block-layout">
          <div class="email-content-block-thumb">${renderBlockThumb(def.id)}</div>
          <div class="email-content-block-fields">
            <div class="email-content-block-header">
              <span class="email-content-block-badge">${def.id}</span>
              <span class="email-content-block-title">${escapeHtml(def.name)}</span>
            </div>
            ${fields}
          </div>
        </div>
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
  // Dimension hint for image fields — shown beside the label so users know
  // the size to match before they paste a URL.
  const dimHint = v.dimensions
    ? `<span class="email-field-hint">${v.dimensions.w} × ${v.dimensions.h} px</span>`
    : ''
  const labelHtml = `<label>${escapeHtml(v.label)}${dimHint}</label>`

  if (v.type === 'textarea') {
    return `
      <div class="email-field">
        ${labelHtml}
        <textarea ${common} rows="2">${escapeHtml(val)}</textarea>
      </div>
    `
  }
  if (v.type === 'color') {
    return `
      <div class="email-field">
        ${labelHtml}
        <input type="color" ${common} value="${escapeHtml(val)}" />
      </div>
    `
  }
  return `
    <div class="email-field">
      ${labelHtml}
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
