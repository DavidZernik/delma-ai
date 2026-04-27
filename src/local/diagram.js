// Render a section body as markdown + (if it contains a mermaid fence) an
// inline SVG diagram whose nodes can be clicked to open a modal showing the
// node's long-form description. Descriptions live in the same section, in
// an H3 subsection named "Step descriptions" / "Node descriptions" / "Notes",
// as bullets:  - **NodeIdOrLabel**: description text
//
// If no description subsection is present, the diagram still renders — just
// without the click-to-reveal behavior. This keeps the simplest case (drop a
// mermaid block in your CLAUDE.md) working with zero ceremony.

import { marked } from 'marked'
import mermaid from 'mermaid'

mermaid.initialize({
  startOnLoad: false,
  theme: 'neutral',
  flowchart: { useMaxWidth: true, curve: 'basis' }
})

const DESCRIPTION_HEADINGS = ['Step descriptions', 'Node descriptions', 'Notes']

// Extract { nodeKey: description } from any H3 subsection in the section
// body whose heading matches one of the recognized names. Bullets must look
// like `- **Key**: text` or `- **Key** — text`.
function parseNodeDescriptions(sectionBody) {
  const map = {}
  const escaped = DESCRIPTION_HEADINGS.map(h => h.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|')
  const headingRe = new RegExp(`^###\\s+(?:${escaped})\\s*$`, 'im')
  const m = sectionBody.match(headingRe)
  if (!m) return map
  const start = m.index + m[0].length
  const tail = sectionBody.slice(start)
  const next = tail.search(/^(?:##|###)\s/m)
  const block = next === -1 ? tail : tail.slice(0, next)
  for (const line of block.split('\n')) {
    const bm = line.match(/^\s*[-*]\s+\*\*(.+?)\*\*\s*[—:-]\s*(.+)$/)
    if (bm) map[bm[1].trim()] = bm[2].trim()
  }
  return map
}

// Single shared modal instance — created on first use, reused thereafter.
function ensureModal() {
  let modal = document.querySelector('.delma-node-modal')
  if (modal) return modal
  modal = document.createElement('div')
  modal.className = 'delma-node-modal'
  modal.hidden = true
  modal.innerHTML = `
    <div class="delma-node-modal-backdrop"></div>
    <div class="delma-node-modal-panel" role="dialog" aria-modal="true">
      <button class="delma-node-modal-close" type="button" aria-label="Close">×</button>
      <div class="delma-node-modal-label"></div>
      <div class="delma-node-modal-body"></div>
    </div>`
  document.body.appendChild(modal)
  const close = () => { modal.hidden = true }
  modal.querySelector('.delma-node-modal-backdrop').addEventListener('click', close)
  modal.querySelector('.delma-node-modal-close').addEventListener('click', close)
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && !modal.hidden) close()
  })
  return modal
}

// Resolve which description (if any) corresponds to a given <g.node> in the
// rendered Mermaid SVG. Mermaid IDs look like `<renderId>-flowchart-<ID>-<n>`.
// We try the structural ID first, then fall back to label substring matching
// so users can write descriptions keyed by either the node ID or its visible
// label (which is friendlier when authoring in plain markdown).
function resolveDescriptionKey(gNode, descriptions) {
  const idMatch = (gNode.id || '').match(/flowchart-(.+?)-\d+$/)
  if (idMatch && descriptions[idMatch[1]]) return idMatch[1]
  const txt = (gNode.textContent || '').replace(/\s+/g, ' ').trim()
  for (const k of Object.keys(descriptions)) {
    if (txt.includes(k)) return k
  }
  return null
}

function wireNodeClicks(svgEl, descriptions) {
  if (!svgEl) return 0
  const modal = ensureModal()
  const labelEl = modal.querySelector('.delma-node-modal-label')
  const bodyEl = modal.querySelector('.delma-node-modal-body')
  let wired = 0
  for (const g of svgEl.querySelectorAll('g.node')) {
    const key = resolveDescriptionKey(g, descriptions)
    if (!key) continue
    wired++
    g.style.cursor = 'pointer'
    g.addEventListener('click', (ev) => {
      ev.stopPropagation()
      labelEl.textContent = key
      bodyEl.textContent = descriptions[key]
      modal.hidden = false
    })
  }
  return wired
}

// Public renderer. Replaces the host's contents with prose-above + diagram +
// prose-below, wires clicks if descriptions are present.
export async function renderSection(host, sectionBody) {
  const body = String(sectionBody || '')
  const fence = body.match(/^([\s\S]*?)```mermaid\n([\s\S]*?)\n```([\s\S]*)$/)
  if (!fence) {
    host.innerHTML = marked.parse(body)
    return
  }
  const [, above, code, below] = fence
  const descriptions = parseNodeDescriptions(body)
  const hasNotes = Object.keys(descriptions).length > 0

  let svg = ''
  try {
    const id = `mmd-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`
    ;({ svg } = await mermaid.render(id, code))
  } catch (err) {
    console.warn('[local] mermaid render failed:', err.message)
    host.innerHTML = marked.parse(body)
    return
  }

  const aboveHtml = above.trim() ? `<div class="diagram-prose">${marked.parse(above)}</div>` : ''
  const belowHtml = below.trim() ? `<div class="diagram-prose">${marked.parse(below)}</div>` : ''
  const hintHtml = hasNotes ? `<div class="diagram-hint">Click any box to see how it works.</div>` : ''

  host.innerHTML = `
    ${aboveHtml}
    ${hintHtml}
    <div class="diagram-card${hasNotes ? ' diagram-card-clickable' : ''}">${svg}</div>
    ${belowHtml}
  `

  if (hasNotes) {
    const wired = wireNodeClicks(host.querySelector('.diagram-card svg'), descriptions)
    console.log(`[local] diagram: ${Object.keys(descriptions).length} descriptions, wired ${wired} nodes`)
  }
}
