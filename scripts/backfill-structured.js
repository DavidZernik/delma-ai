#!/usr/bin/env node
// One-shot backfill: convert legacy markdown content → structured JSON.
//
// For every memory_notes + org_memory_notes row whose filename is a
// structured tab and whose `structured` column is still NULL:
//   1. Parse the current markdown content into structured JSON (deterministic
//      parsers for the easy four; Haiku-assisted for people.md).
//   2. Re-render from structured (so `content` becomes the canonical view).
//   3. Write both back.
//
// Safe to re-run — it skips rows that already have `structured` set.
//
// Usage: node scripts/backfill-structured.js [--dry] [--filename=people.md]

import { config as loadEnv } from 'dotenv'
loadEnv({ override: true })
import { createClient } from '@supabase/supabase-js'
import { render, emptyData, isStructuredTab } from '../src/tab-ops.js'
import { extractJsonArray } from '../src/extract-json-array.js'

const argv = process.argv.slice(2)
const DRY = argv.includes('--dry')
const FILENAME_FILTER = (argv.find(a => a.startsWith('--filename=')) || '').split('=')[1] || null

if (!process.env.SUPABASE_URL || !process.env.SUPABASE_SERVICE_ROLE_KEY) {
  console.error('SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY required in .env')
  process.exit(1)
}
if (!process.env.ANTHROPIC_API_KEY) {
  console.error('ANTHROPIC_API_KEY required for People parsing')
  process.exit(1)
}

const sb = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY, {
  auth: { autoRefreshToken: false, persistSession: false }
})

// ── Deterministic parsers ────────────────────────────────────────────────

function parseMyNotes(md) {
  // Strip leading "# My Notes" header if present, keep the rest as free text.
  const stripped = md.replace(/^#\s*My Notes\s*\n+/i, '').trim()
  return { text: stripped }
}

function parseDecisions(md) {
  // Two sections: ## Decisions and ## Actions, each a bullet list.
  const pickSection = (name) => {
    const m = md.match(new RegExp(`##\\s*${name}[^\\n]*\\n([\\s\\S]*?)(?=\\n##\\s|$)`, 'i'))
    if (!m) return []
    return m[1].split('\n')
      .map(l => l.match(/^\s*-\s*(?:\[([x ])\]\s*)?(.*)$/i))
      .filter(Boolean)
      .map(m => ({ done: (m[1] || '').toLowerCase() === 'x', raw: m[2].trim() }))
      .filter(x => x.raw && !/^_?\(?none|^_\(?empty/i.test(x.raw))
  }
  const mkDecision = (raw) => {
    const ownerM = raw.match(/\s*[_(]([^)_]+)[)_]\s*$/)
    return { id: `d_${Math.random().toString(36).slice(2, 7)}`, text: ownerM ? raw.replace(ownerM[0], '').trim() : raw, owner: ownerM ? ownerM[1].trim() : null }
  }
  const mkAction = (raw, done) => {
    const dueM = raw.match(/—\s*due\s+(.+?)\s*(?:[_(]([^)_]+)[)_])?\s*$/i)
    const ownerM = raw.match(/\s*[_(]([^)_]+)[)_]/)
    let text = raw, owner = null, due = null
    if (dueM) { due = dueM[1].trim(); text = raw.replace(dueM[0], '').trim() }
    if (ownerM) { owner = ownerM[1].trim(); text = text.replace(ownerM[0], '').trim() }
    return { id: `a_${Math.random().toString(36).slice(2, 7)}`, text, owner, due, done: !!done }
  }
  return {
    decisions: pickSection('Decisions').map(x => mkDecision(x.raw)),
    actions: pickSection('Actions').map(x => mkAction(x.raw, x.done))
  }
}

function parseEnvironment(md) {
  // Bullets like: - **key**: value — note
  const entries = []
  for (const line of md.split('\n')) {
    const m = line.match(/^\s*-\s*\*\*(.+?)\*\*:\s*(.+?)(?:\s*—\s*(.+))?\s*$/)
    if (m) entries.push({ key: m[1].trim(), value: m[2].trim(), note: (m[3] || '').trim() || null })
  }
  return { entries }
}

function parsePlaybook(md) {
  // Sections (## Heading) each containing bullet rules.
  const rules = []
  let currentSection = null
  for (const line of md.split('\n')) {
    const h = line.match(/^##\s+(.+?)\s*$/)
    if (h) { currentSection = h[1].trim(); continue }
    const b = line.match(/^\s*-\s+(.+?)\s*$/)
    if (b && !/^_\(?none|empty/i.test(b[1])) {
      rules.push({ id: `r_${Math.random().toString(36).slice(2, 7)}`, text: b[1].trim(), section: currentSection })
    }
  }
  return { rules }
}

// ── LLM parser for People ────────────────────────────────────────────────

async function parsePeopleWithLLM(md) {
  const sys = `Extract the People org chart from the given markdown (which may include a Mermaid flowchart) into JSON matching this schema:

{
  "people": [
    { "id": "<short_slug>", "name": "<full name>", "role": "<role/title or null>", "kind": "person" | "manager" | "stakeholder" | "team" | "vendor", "reports_to": ["<id of manager>", ...] }
  ]
}

Rules:
- id: snake_case short slug of first name, e.g. "keyona" or "david"
- kind: infer from Mermaid shape/class (::manager, ::person, ::stakeholder, ::team, ::vendor). Default "person".
- reports_to: ids of nodes that arrow INTO this node in the Mermaid (A --> B means B reports to A, so B.reports_to includes A.id).
- If there are no people, return {"people": []}.

Return ONLY valid JSON. No prose. No code fences.`

  const res = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': process.env.ANTHROPIC_API_KEY,
      'anthropic-version': '2023-06-01'
    },
    body: JSON.stringify({
      model: 'claude-haiku-4-5', max_tokens: 2000, system: sys,
      messages: [{ role: 'user', content: md }]
    })
  })
  if (!res.ok) throw new Error(`Anthropic ${res.status}: ${await res.text()}`)
  const data = await res.json()
  const raw = data.content?.[0]?.text?.trim() || '{}'
  const cleaned = raw.replace(/^```(?:json)?\n?/, '').replace(/\n?```$/, '')
  try { return JSON.parse(cleaned) }
  catch { return { people: [] } }
}

// ── Dispatcher ───────────────────────────────────────────────────────────

const PARSERS = {
  'my-notes.md': async (md) => parseMyNotes(md),
  'decisions.md': async (md) => parseDecisions(md),
  'environment.md': async (md) => parseEnvironment(md),
  'playbook.md': async (md) => parsePlaybook(md),
  'people.md': async (md) => parsePeopleWithLLM(md)
}

function looksEmpty(md, filename) {
  const m = (md || '').trim()
  if (!m) return true
  // If it matches the canonical empty template (just the header + seed prose), treat as empty.
  const stripped = m.replace(/\s+/g, ' ').toLowerCase()
  return stripped.length < 120 && !/```/.test(stripped)
}

async function backfillRows(table) {
  const { data: rows, error } = await sb.from(table).select('*')
  if (error) throw new Error(`${table}: ${error.message}`)

  let done = 0, skipped = 0, failed = 0
  for (const row of rows) {
    if (FILENAME_FILTER && row.filename !== FILENAME_FILTER) continue
    if (!isStructuredTab(row.filename)) { skipped++; continue }
    if (row.structured) { skipped++; continue }

    console.log(`→ ${table}/${row.filename} (id=${row.id.slice(0, 8)}) ...`)

    let structured
    if (looksEmpty(row.content, row.filename)) {
      structured = emptyData(row.filename)
      console.log(`  empty — using default shape`)
    } else {
      try {
        structured = await PARSERS[row.filename](row.content)
        const counts = summarize(row.filename, structured)
        console.log(`  parsed — ${counts}`)
      } catch (err) {
        console.error(`  FAILED: ${err.message}`)
        failed++
        continue
      }
    }

    const content = render(row.filename, structured)

    if (DRY) {
      console.log(`  [dry] would write structured (${JSON.stringify(structured).length} chars) + content (${content.length} chars)`)
      done++
      continue
    }

    const { error: updErr } = await sb.from(table).update({ structured, content }).eq('id', row.id)
    if (updErr) { console.error(`  save failed: ${updErr.message}`); failed++; continue }
    console.log(`  ✓ saved`)
    done++
  }
  return { done, skipped, failed }
}

function summarize(filename, data) {
  if (filename === 'people.md') return `${data.people?.length || 0} people`
  if (filename === 'playbook.md') return `${data.rules?.length || 0} rules`
  if (filename === 'environment.md') return `${data.entries?.length || 0} entries`
  if (filename === 'decisions.md') return `${data.decisions?.length || 0} decisions, ${data.actions?.length || 0} actions`
  if (filename === 'my-notes.md') return `${(data.text || '').length} chars`
  return JSON.stringify(data).length + ' chars'
}

console.log(DRY ? '🧪 DRY RUN — no writes' : '🔨 LIVE — will write to Supabase')
if (FILENAME_FILTER) console.log(`filter: filename=${FILENAME_FILTER}`)

const a = await backfillRows('memory_notes')
const b = await backfillRows('org_memory_notes')

console.log(`\n━━━ DONE ━━━`)
console.log(`memory_notes:     ${a.done} done, ${a.skipped} skipped, ${a.failed} failed`)
console.log(`org_memory_notes: ${b.done} done, ${b.skipped} skipped, ${b.failed} failed`)
