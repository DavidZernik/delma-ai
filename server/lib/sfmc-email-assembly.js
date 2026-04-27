// Assemble an SFMC Asset Type 207 (Template-Based Email) JSON payload.
//
// Input (what the "New Email" modal sends):
//   {
//     name,                // asset name in Content Builder
//     customerKey,         // external key (defaults to name)
//     subject,             // inbox subject line
//     preheader,           // inbox preview text (optional — user edits in SFMC)
//     categoryId,          // folder ID
//     templateId,          // SFMC template asset ID (the v4.2 shell uploaded once)
//     blocks: [            // user-picked blocks in order
//       { id: 'HB10', vars: { headline: '...', button_url: '...' } },
//       { id: 'HB11', vars: { ... } }
//     ]
//   }
//
// Output: the full 207 JSON ready to POST to /asset/v1/content/assets/.
//
// Key invariants (learned the hard way — see April 2026 corruption notes):
//  - slot.blocks[key].content MUST match what slot.content references
//  - slot.content is regenerated from scratch every time (never patched)
//  - every block has a unique key; mixing keys corrupts the slot

import { BLOCKS_BY_ID, renderBlock, BASE_TEMPLATE } from '../email-library/index.js'

// SFMC asset type for an editable raw-HTML block in the drag-and-drop editor.
// htmlblock is 197; it stores HTML in `content` and is editable in Content
// Builder's right panel. (id 199 is imageblock — using that id with HTML
// content triggers "Your account is not provisioned with this block".)
const FREE_HTML_BLOCK_ASSET_TYPE = { id: 197, name: 'htmlblock' }

// Substitute `<div data-type="slot" data-key="X"></div>` in the template HTML
// with the rendered slot content. SFMC won't auto-compile `views.html.content`
// on POST — if we leave it empty, Content Builder falls back to the legacy
// editor and Code View is blank. So we compile server-side.
function compileTemplate(templateHtml, slotContents) {
  let out = templateHtml
  for (const [slotKey, content] of Object.entries(slotContents)) {
    const re = new RegExp(`<div data-type="slot" data-key="${slotKey}"></div>`, 'g')
    out = out.replace(re, `<div data-type="slot" data-key="${slotKey}">${content}</div>`)
  }
  return out
}

export function assemble207({
  name,
  customerKey,
  subject,
  preheader,
  categoryId,
  templateId,
  blocks
}) {
  if (!name) throw new Error('assemble207: name required')
  if (!subject) throw new Error('assemble207: subject required')
  if (!categoryId) throw new Error('assemble207: categoryId required')
  if (!templateId) throw new Error('assemble207: templateId (SFMC template asset ID) required')
  if (!Array.isArray(blocks) || !blocks.length) throw new Error('assemble207: non-empty blocks[] required')

  // Render each block and assign a stable key.
  const renderedBlocks = blocks.map((b, i) => {
    const def = BLOCKS_BY_ID[b.id]
    if (!def) throw new Error(`assemble207: unknown block id "${b.id}"`)
    return {
      key: `block_${i + 1}_${b.id.toLowerCase()}`,
      html: renderBlock(def, b.vars || {}),
      defId: b.id
    }
  })

  // slot.blocks map — one entry per block. SFMC stores `content` (sent HTML)
  // AND `design` (editor view). Both are required; a missing `design` leaves
  // Content Builder's drag-and-drop editor empty. For free-HTML blocks the
  // two are identical.
  const slotBlocks = {}
  for (const rb of renderedBlocks) {
    slotBlocks[rb.key] = {
      assetType: FREE_HTML_BLOCK_ASSET_TYPE,
      content: rb.html,
      design: rb.html,
      meta: { wrapperStyles: { mobile: { visible: true } } },
      availableViews: [],
      data: {},
      modelVersion: 2
    }
  }

  // slot.content — the concatenated block references. This is what SFMC
  // reads to know the order of blocks. Rebuilt from renderedBlocks every
  // time, never patched. Each ref wraps a block in the data-type="block"
  // marker SFMC uses internally.
  const slotContent = renderedBlocks
    .map(rb => `<div data-type="block" data-key="${rb.key}">${rb.html}</div>`)
    .join('\n')

  // views.html.content — the compiled send-ready HTML. SFMC does NOT compile
  // this on its own when you POST; we substitute the slot markers in the
  // base template with the slot content so Content Builder can render.
  const compiledHtml = compileTemplate(BASE_TEMPLATE.html, { main: slotContent })

  // Assemble the full 207 asset JSON.
  return {
    name,
    customerKey: customerKey || name,
    assetType: { id: 207, name: 'templatebasedemail' },
    category: { id: categoryId },
    views: {
      subjectline: {
        contentType: 'application/vnd.etmc-email.subjectline',
        content: subject,
        meta: {}
      },
      preheader: {
        contentType: 'application/vnd.etmc-email.preheader',
        content: preheader || '',
        meta: {}
      },
      html: {
        contentType: 'application/vnd.etmc-email.htmlemail',
        content: compiledHtml,
        template: { id: templateId },
        slots: {
          main: {
            content: slotContent,
            design: slotContent,
            availableViews: [],
            blocks: slotBlocks,
            data: {},
            modelVersion: 2
          }
        },
        availableViews: [],
        data: {},
        modelVersion: 2
      },
      text: {
        contentType: 'application/vnd.etmc-email.textemail',
        content: '',
        generateFrom: 'html',
        meta: {}
      }
    },
    data: { email: { options: { characterEncoding: 'utf-8' } } }
  }
}

// Sanity validator — runs before the HTTP POST. Cheap structural checks.
// The real validator is SFMC itself, but these catch the most common
// corruption patterns early with clearer error messages.
export function validate207(payload) {
  const errors = []
  if (payload.assetType?.id !== 207) errors.push('assetType.id must be 207')
  if (!payload.views?.html?.template?.id) errors.push('views.html.template.id missing')
  if (!payload.views?.html?.slots?.main) errors.push('views.html.slots.main missing')
  const slot = payload.views?.html?.slots?.main
  if (slot) {
    const blockKeys = Object.keys(slot.blocks || {})
    if (blockKeys.length === 0) errors.push('slot.blocks is empty')
    // Every block referenced in slot.content must exist in slot.blocks.
    const refs = [...(slot.content || '').matchAll(/data-key="([^"]+)"/g)].map(m => m[1])
    for (const ref of refs) {
      if (!blockKeys.includes(ref)) errors.push(`slot.content references block "${ref}" that doesn't exist in slot.blocks`)
    }
  }
  if (!payload.views?.subjectline?.content) errors.push('subjectline is empty')
  if (!payload.category?.id) errors.push('category.id missing')
  return { ok: errors.length === 0, errors }
}
