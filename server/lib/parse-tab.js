// Parse markdown content for a structured tab back into structured JSON.
// Used by:
//   - scripts/backfill-structured.js (one-shot legacy → structured)
//   - server/index.js POST /api/save-structured-tab (when the user edits the
//     markdown view directly and clicks Save — we need to re-derive structure
//     so future typed-op edits see fresh data)
//
// Deterministic regex parsers for the simple tabs (Decisions, Environment,
// Playbook, My Notes). LLM-assisted parser for People (Mermaid → JSON).

import { isStructuredTab } from '../../src/tab-ops.js'

function rid(prefix) {
  return `${prefix}_${Math.random().toString(36).slice(2, 7)}`
}

export function parseMyNotes(md) {
  const stripped = (md || '').replace(/^#\s*My Notes\s*\n+/i, '').trim()
  return { text: stripped }
}

export function parseDecisions(md) {
  const pickSection = (name) => {
    const m = (md || '').match(new RegExp(`##\\s*${name}[^\\n]*\\n([\\s\\S]*?)(?=\\n##\\s|$)`, 'i'))
    if (!m) return []
    return m[1].split('\n')
      .map(l => l.match(/^\s*-\s*(?:\[([x ])\]\s*)?(.*)$/i))
      .filter(Boolean)
      .map(m => ({ done: (m[1] || '').toLowerCase() === 'x', raw: m[2].trim() }))
      .filter(x => x.raw && !/^_?\(?none|^_\(?empty/i.test(x.raw))
  }
  const mkDecision = (raw) => {
    const ownerM = raw.match(/\s*[_(]([^)_]+)[)_]\s*$/)
    return { id: rid('d'), text: ownerM ? raw.replace(ownerM[0], '').trim() : raw, owner: ownerM ? ownerM[1].trim() : null }
  }
  const mkAction = (raw, done) => {
    const dueM = raw.match(/—\s*due\s+(.+?)\s*(?:[_(]([^)_]+)[)_])?\s*$/i)
    const ownerM = raw.match(/\s*[_(]([^)_]+)[)_]/)
    let text = raw, owner = null, due = null
    if (dueM) { due = dueM[1].trim(); text = raw.replace(dueM[0], '').trim() }
    if (ownerM) { owner = ownerM[1].trim(); text = text.replace(ownerM[0], '').trim() }
    return { id: rid('a'), text, owner, due, done: !!done }
  }
  return {
    decisions: pickSection('Decisions').map(x => mkDecision(x.raw)),
    actions: pickSection('Actions').map(x => mkAction(x.raw, x.done))
  }
}

export function parseEnvironment(md) {
  const entries = []
  for (const line of (md || '').split('\n')) {
    const m = line.match(/^\s*-\s*\*\*(.+?)\*\*:\s*(.+?)(?:\s*—\s*(.+))?\s*$/)
    if (m) entries.push({ key: m[1].trim(), value: m[2].trim(), note: (m[3] || '').trim() || null })
  }
  return { entries }
}

export function parsePlaybook(md) {
  const rules = []
  let currentSection = null
  for (const line of (md || '').split('\n')) {
    const h = line.match(/^##\s+(.+?)\s*$/)
    if (h) { currentSection = h[1].trim(); continue }
    const b = line.match(/^\s*-\s+(.+?)\s*$/)
    if (b && !/^_\(?none|empty/i.test(b[1])) {
      rules.push({ id: rid('r'), text: b[1].trim(), section: currentSection })
    }
  }
  return { rules }
}

// Async: People parsing requires LLM because the source contains Mermaid.
export async function parsePeopleWithLLM(md, anthropicKey) {
  if (!anthropicKey) throw new Error('ANTHROPIC_API_KEY required to parse People')
  const sys = `Extract the People org chart from the given markdown (which may include a Mermaid flowchart) into JSON matching this schema:

{
  "people": [
    { "id": "<short_slug>", "name": "<full name>", "role": "<role/title or null>", "kind": "person" | "manager" | "stakeholder" | "team" | "vendor", "reports_to": ["<id of manager>"] }
  ]
}

Rules:
- id: snake_case short slug of first name, e.g. "keyona" or "david"
- kind: infer from Mermaid shape/class. Default "person".
- reports_to: ids of nodes that arrow INTO this node (A --> B means B.reports_to includes A.id).
- If empty, return {"people": []}.

Return ONLY valid JSON. No prose. No code fences.`

  const res = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': anthropicKey,
      'anthropic-version': '2023-06-01'
    },
    body: JSON.stringify({
      model: 'claude-haiku-4-5', max_tokens: 2000, system: sys,
      messages: [{ role: 'user', content: md || '' }]
    })
  })
  if (!res.ok) throw new Error(`Anthropic ${res.status}: ${await res.text()}`)
  const data = await res.json()
  const raw = data.content?.[0]?.text?.trim() || '{}'
  const cleaned = raw.replace(/^```(?:json)?\n?/, '').replace(/\n?```$/, '')
  try { return JSON.parse(cleaned) }
  catch { return { people: [] } }
}

// Dispatcher. Returns parsed JSON or null if filename is not a structured tab.
export async function parseStructuredContent(filename, content, { anthropicKey } = {}) {
  if (!isStructuredTab(filename)) return null
  switch (filename) {
    case 'my-notes.md': return parseMyNotes(content)
    case 'decisions.md': return parseDecisions(content)
    case 'environment.md': return parseEnvironment(content)
    case 'playbook.md': return parsePlaybook(content)
    case 'people.md': return parsePeopleWithLLM(content, anthropicKey)
    default: return null
  }
}
