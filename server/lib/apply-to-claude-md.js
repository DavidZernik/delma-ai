// Apply a suggestion (from the agent's <delma-suggest> block) to a local
// CLAUDE.md file. Each MCP tool name maps to a deterministic markdown
// transformation: append a bullet, flip a checkbox, update an existing
// line, strike through a superseded entry.
//
// Operations are TEXTUAL — we parse bullets out of a section, transform
// the list, re-serialize. No custom JSON schema alongside the file; the
// markdown IS the representation, same as what the user sees in their
// editor.
//
// Bullet shapes we emit:
//   Actions:       "- [ ] Define source DE" (unchecked)
//                  "- [x] Define source DE" (complete)
//   Decisions:     "- Lapsed = 90 days no engagement"
//                  "- ~~Lapsed = 60 days~~ Lapsed = 90 days (superseded)"
//   Environment:   "- **SourceDE**: ENT.All_Patients_Opted_In"
//   People:        "- **Keyona** — QA Lead (reports to David)"
//
// When a tool target's subsection doesn't exist yet, we create it at the
// bottom of the section. When a target entry isn't found (supersede/
// complete), the op falls back to append so no information is dropped.

import { basename } from 'node:path'
import { readOrSeedClaudeMd, writeClaudeMd } from './claude-md.js'

// ── Section + sub-section addressing ─────────────────────────────────────

// Maps each supported tool to: which top-level section body it edits,
// which sub-heading inside it (or null = append to the section body),
// and which operation verb to apply.
const TOOL_MAP = {
  // Decisions
  'mcp__delma__delma_add_decision':            { section: 'projectDetails', sub: 'Decisions', op: 'add' },
  'mcp__delma__delma_supersede_decision':      { section: 'projectDetails', sub: 'Decisions', op: 'supersede' },

  // Actions
  'mcp__delma__delma_add_action':              { section: 'projectDetails', sub: 'Actions',   op: 'addTodo' },
  'mcp__delma__delma_complete_action':         { section: 'projectDetails', sub: 'Actions',   op: 'checkTodo' },
  'mcp__delma__delma_complete_action_by_text': { section: 'projectDetails', sub: 'Actions',   op: 'checkTodo' },

  // File Locations and Keys (key/value lookup table)
  'mcp__delma__delma_set_environment_key':     { section: 'fileLocations', sub: null, op: 'upsertKV' },

  // General Notes (conventions, rules, unwritten norms)
  'mcp__delma__delma_add_playbook_rule':       { section: 'generalNotes', sub: null, op: 'add' }
}

// ── Sub-section helpers ──────────────────────────────────────────────────

const H3_RE_TEMPLATE = (name) =>
  new RegExp(`^###\\s+${escapeRegex(name)}\\s*$`, 'mi')

function escapeRegex(s) { return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') }

// Find the block of body text under a given H3 sub-heading inside a
// section body. Returns { startOfBlock, endOfBlock, block } with block
// including trailing blank line if any. If the heading is absent,
// returns null — caller creates it.
function locateSubsection(sectionBody, subName) {
  const body = String(sectionBody || '')
  const m = body.match(H3_RE_TEMPLATE(subName))
  if (!m) return null
  const start = m.index + m[0].length + 1 // skip heading + newline
  const tail = body.slice(start)
  const nextH = tail.search(/^(?:##|###)\s/m)
  const end = nextH === -1 ? body.length : start + nextH
  return { start, end, block: body.slice(start, end) }
}

// Replace (or create) a sub-section's body inside a section body.
function setSubsection(sectionBody, subName, newBlock) {
  const body = String(sectionBody || '')
  const loc = locateSubsection(body, subName)
  // Always trim to single trailing newline for clean re-serialization.
  const clean = newBlock.replace(/\n*$/, '\n')
  if (!loc) {
    const spacer = body.endsWith('\n\n') ? '' : (body.endsWith('\n') ? '\n' : '\n\n')
    return `${body}${spacer}### ${subName}\n${clean}`
  }
  return body.slice(0, loc.start) + clean + body.slice(loc.end)
}

// Split a sub-section body into non-empty bullet lines + any prelude
// (non-bullet text between the heading and the first bullet). Keeps
// empty "_(none)_" / "_(empty)_" placeholders OUT so our appends don't
// accumulate them.
function parseBullets(block) {
  const lines = String(block || '').split('\n')
  const prelude = []
  const bullets = []
  let seenBullet = false
  for (const line of lines) {
    const isBullet = /^\s*[-*]\s/.test(line)
    if (!isBullet) {
      if (!seenBullet) {
        // Drop the underscore placeholders entirely — they're UX
        // hints, not content worth preserving.
        if (/^\s*_\((?:empty|none)[^)]*\)_\s*$/i.test(line)) continue
        prelude.push(line)
      }
      continue
    }
    seenBullet = true
    bullets.push(line)
  }
  return {
    prelude: prelude.join('\n').trim(),
    bullets: bullets
  }
}

// Stitch prelude + bullets back into a block. Preserves trailing newline.
function serializeBullets({ prelude, bullets }) {
  const parts = []
  if (prelude && prelude.trim()) parts.push(prelude.trim(), '')
  parts.push(...bullets)
  return parts.join('\n') + '\n'
}

// ── Operation implementations ────────────────────────────────────────────

// Each op takes (currentBlock, input) and returns the new block.
// Block = the sub-section body as raw markdown (prelude + bullets).
const OPS = {
  add: (block, input) => {
    const parsed = parseBullets(block)
    parsed.bullets.push(`- ${inputToText(input)}`)
    return serializeBullets(parsed)
  },

  addTodo: (block, input) => {
    const parsed = parseBullets(block)
    parsed.bullets.push(`- [ ] ${inputToText(input)}`)
    return serializeBullets(parsed)
  },

  // Flip an action from [ ] to [x]. Match by id (if provided) else by
  // fuzzy text equality. If no match, append as a new completed item so
  // the user still sees the intent recorded.
  checkTodo: (block, input) => {
    const parsed = parseBullets(block)
    const target = (input.text || input.id || '').toLowerCase().trim()
    let matched = false
    parsed.bullets = parsed.bullets.map(b => {
      if (matched) return b
      const body = b.replace(/^\s*[-*]\s*\[[ x]\]\s*/i, '').toLowerCase().trim()
      if (target && (body === target || body.includes(target) || target.includes(body))) {
        matched = true
        return b.replace(/\[ \]/, '[x]')
      }
      return b
    })
    if (!matched && input.text) {
      parsed.bullets.push(`- [x] ${input.text} _(marked done)_`)
    }
    return serializeBullets(parsed)
  },

  // Strike through an existing decision and append the replacement.
  supersede: (block, input) => {
    const parsed = parseBullets(block)
    const oldText = (input.old_text || input.superseded_text || '').trim()
    const newText = (input.new_text || input.text || '').trim()
    if (!newText) return block
    if (oldText) {
      parsed.bullets = parsed.bullets.map(b => {
        const body = b.replace(/^\s*[-*]\s*/, '').trim()
        if (body === oldText || body.startsWith(oldText)) {
          return `- ~~${oldText}~~ → ${newText} _(superseded)_`
        }
        return b
      })
    } else {
      // No old_text given — just append the new decision with a note.
      parsed.bullets.push(`- ${newText}`)
    }
    return serializeBullets(parsed)
  },

  // "- **KEY**: value" upsert. If the key exists, replace its value;
  // else append a new bullet.
  upsertKV: (block, input) => {
    const parsed = parseBullets(block)
    const key = (input.key || '').trim()
    const value = (input.value || '').trim()
    if (!key) return block
    const kvRe = new RegExp(`^\\s*[-*]\\s+\\*\\*${escapeRegex(key)}\\*\\*\\s*:\\s*`, 'i')
    let matched = false
    parsed.bullets = parsed.bullets.map(b => {
      if (matched) return b
      if (kvRe.test(b)) {
        matched = true
        return `- **${key}**: ${value}`
      }
      return b
    })
    if (!matched) parsed.bullets.push(`- **${key}**: ${value}`)
    return serializeBullets(parsed)
  },

  // Append a person line, skipping exact-name duplicates.
  addPerson: (block, input) => {
    const parsed = parseBullets(block)
    const name = (input.name || '').trim()
    if (!name) return block
    if (parsed.bullets.some(b => b.toLowerCase().includes(`**${name.toLowerCase()}**`))) return block
    const role = input.role ? ` — ${input.role}` : ''
    parsed.bullets.push(`- **${name}**${role}`)
    return serializeBullets(parsed)
  },

  // Update a person's role; fall back to append if the person isn't here.
  setPersonRole: (block, input) => {
    const parsed = parseBullets(block)
    const name = (input.name || '').trim()
    const role = (input.role || '').trim()
    if (!name) return block
    let matched = false
    parsed.bullets = parsed.bullets.map(b => {
      if (matched) return b
      const m = b.match(new RegExp(`^(\\s*[-*]\\s+\\*\\*${escapeRegex(name)}\\*\\*)`, 'i'))
      if (m) {
        matched = true
        return `${m[1]}${role ? ` — ${role}` : ''}`
      }
      return b
    })
    if (!matched) parsed.bullets.push(`- **${name}**${role ? ` — ${role}` : ''}`)
    return serializeBullets(parsed)
  },

  // Append "reports to X" note to a person's line.
  setManager: (block, input) => {
    const parsed = parseBullets(block)
    const name = (input.name || input.person || '').trim()
    const mgr = (input.manager || input.reports_to || '').trim()
    if (!name || !mgr) return block
    let matched = false
    parsed.bullets = parsed.bullets.map(b => {
      if (matched) return b
      if (b.toLowerCase().includes(`**${name.toLowerCase()}**`)) {
        matched = true
        // Remove any prior "(reports to ...)" suffix.
        const cleaned = b.replace(/\s*\(reports to [^)]*\)\s*$/i, '')
        return `${cleaned} _(reports to ${mgr})_`
      }
      return b
    })
    if (!matched) parsed.bullets.push(`- **${name}** _(reports to ${mgr})_`)
    return serializeBullets(parsed)
  },

  // Remove a person by name. No-op if not present.
  removePerson: (block, input) => {
    const parsed = parseBullets(block)
    const name = (input.name || '').trim()
    if (!name) return block
    parsed.bullets = parsed.bullets.filter(b =>
      !b.toLowerCase().includes(`**${name.toLowerCase()}**`)
    )
    return serializeBullets(parsed)
  },

  // Remove a reporting line bullet "A → B".
  removeLine: (block, input) => {
    const parsed = parseBullets(block)
    const from = (input.from || '').trim()
    const to = (input.to || '').trim()
    const marker = from && to ? `${from} → ${to}` : null
    if (!marker) return block
    parsed.bullets = parsed.bullets.filter(b => !b.includes(marker))
    return serializeBullets(parsed)
  }
}

// Pick a readable text label out of a free-form input for the `add` /
// `addTodo` ops. Falls back to JSON if nothing sensible is present.
function inputToText(input) {
  if (!input || typeof input !== 'object') return '(no input)'
  if (typeof input.text === 'string' && input.text.trim()) return input.text.trim()
  if (input.from && input.to) return `${input.from} → ${input.to}`
  if (input.name && input.role) return `${input.name} — ${input.role}`
  if (input.name) return input.name
  return JSON.stringify(input)
}

// ── Public API ───────────────────────────────────────────────────────────

export function applySuggestionToClaudeMd(projectDir, suggestion) {
  const target = TOOL_MAP[suggestion.tool]
  if (!target) throw new Error(`No CLAUDE.md mapping for tool: ${suggestion.tool}`)
  const doc = readOrSeedClaudeMd(projectDir, { projectName: basename(projectDir) })
  const sections = { ...doc.sections }
  const currentSection = sections[target.section] || ''

  const op = OPS[target.op]
  if (!op) throw new Error(`Unknown op "${target.op}" for tool ${suggestion.tool}`)

  if (target.sub) {
    // Operate on a sub-section's block.
    const loc = locateSubsection(currentSection, target.sub)
    const currentBlock = loc ? loc.block : ''
    const newBlock = op(currentBlock, suggestion.input || {})
    sections[target.section] = setSubsection(currentSection, target.sub, newBlock)
  } else {
    // Operate on the whole section body.
    sections[target.section] = op(currentSection, suggestion.input || {})
  }

  writeClaudeMd(projectDir, { title: doc.title, summary: doc.summary, sections })
  return { section: target.section, sub: target.sub, op: target.op }
}

// Surfaces for tests + introspection.
export { TOOL_MAP, OPS }
