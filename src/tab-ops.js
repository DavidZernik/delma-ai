// Tab schemas, renderers, and op handlers.
//
// This is the foundation layer for structured tab storage:
// - Each tab has a JSON shape defined in TAB_SCHEMAS.
// - Each tab has a pure renderer: (data) => markdown string.
// - Each op is a pure function: (data, args) => newData.
//
// Pure functions only. No Supabase, no fetch, no side effects.
// Shared between browser (main.js) and node (server/mcp.js, eval).

// ── Schemas ──────────────────────────────────────────────────────────────
// Canonical empty data shape for each tab filename.

export const TAB_SCHEMAS = {
  'people.md': () => ({ people: [] }),
  'playbook.md': () => ({ rules: [] }),
  'environment.md': () => ({ entries: [] }),
  'decisions.md': () => ({ decisions: [], actions: [] }),
  'my-notes.md': () => ({ text: '' }),
  // Architecture diagrams live in diagram_views, not memory_notes — but we
  // share the same structured-ops machinery. The view_key is the "filename".
  'architecture': () => ({ prose: '', nodes: [], edges: [], layers: [] })
}

export function emptyData(filename) {
  const fn = TAB_SCHEMAS[filename]
  return fn ? fn() : null
}

// Tabs we know how to handle as structured. Anything else stays free-form.
export function isStructuredTab(filename) {
  return !!TAB_SCHEMAS[filename]
}

// ── Helpers ──────────────────────────────────────────────────────────────

function slugify(s) {
  return String(s || '').toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_|_$/g, '')
}

function ensureId(item, prefix) {
  if (item.id) return item
  return { ...item, id: `${prefix}_${slugify(item.name || item.key || item.text || '')}_${Math.random().toString(36).slice(2, 7)}` }
}

function findByName(list, name) {
  if (!name) return null
  const lower = name.toLowerCase().trim()
  return list.find(p => (p.name || '').toLowerCase().trim() === lower)
    || list.find(p => (p.name || '').toLowerCase().includes(lower))
}

// ── Dedup helpers ────────────────────────────────────────────────────
// Handler-level dedup is the core lesson from today's overnight runs: the
// LLM was being told "don't duplicate" in prose and cheerfully ignored it.
// Enforce in code. When a near-duplicate is detected, throw with a clear
// error message pointing to the existing id and the right op to use — the
// LLM sees that as a tool_result and typically adapts on the next turn.

// Very cheap stemmer — good enough to collapse "ships"/"shipping"/"ship"
// and "fridays"/"friday", which is what today's critic complaints require.
function stemWord(w) {
  if (w.length <= 4) return w
  let s = w.replace(/ing$/, '').replace(/ed$/, '').replace(/es$/, '').replace(/s$/, '')
  // Undouble terminal consonant ("shipp" from stripping "ing" off "shipping" → "ship")
  if (/([bcdfglmnprst])\1$/.test(s)) s = s.slice(0, -1)
  return s
}

// Low-value filler words that should not count as distinctive matches.
// Kept small — over-aggressive stop-listing creates false negatives.
const STOPWORDS = new Set([
  'the', 'and', 'for', 'that', 'this', 'with', 'from', 'not', 'any', 'all',
  'use', 'set', 'add', 'new', 'get', 'can', 'will', 'are', 'was', 'have',
  'has', 'had', 'is', 'be', 'do', 'does', 'our', 'us', 'we', 'you', 'it',
  'its', 'no', 'yes', 'still', 'now', 'then', 'so', 'an', 'a', 'on', 'in',
  'at', 'to', 'of', 'by', 'as', 'or', 'if', 'but'
])

// Normalize free-text for similarity comparison:
// lowercase, strip punctuation + version numbers, collapse whitespace.
function normalizeText(s) {
  return String(s || '')
    .toLowerCase()
    .replace(/[_\-.]+/g, ' ')            // unify id-style separators with word breaks
    .replace(/([a-z])([A-Z])/g, '$1 $2') // split camelCase (before lowercasing above — but we already lowercased, so this is a no-op here; keep for readability)
    .replace(/\bv\d+(\.\d+)?\b/g, '')     // drop version suffixes (v3, v1.2)
    .replace(/\b\d{4,}\b/g, '')           // drop 4+ digit numbers (year, IDs)
    .replace(/[^\w\s]/g, ' ')             // strip punctuation
    .replace(/\s+/g, ' ')
    .trim()
}

// Extract distinctive word stems (drop stopwords, stem what's left).
function distinctiveStems(s) {
  return normalizeText(s)
    .split(' ')
    .filter(w => w.length > 2 && !STOPWORDS.has(w))
    .map(stemWord)
}

// True if `a` and `b` share enough distinctive content to be considered the
// same concept. Uses coverage of the SHORTER term: if ≥ 2 distinctive stems
// match AND those matches cover ≥ 60% of the shorter term, it's a dup. This
// catches the patterns today's critic flagged ("nothing ships on fridays"
// vs "no shipping on friday"; "7 Friday rules") without over-matching rules
// that merely share filler words.
function textsAreNearDup(a, b) {
  const aw = distinctiveStems(a)
  const bw = distinctiveStems(b)
  if (aw.length === 0 || bw.length === 0) return false
  const aset = new Set(aw), bset = new Set(bw)
  let matches = 0
  for (const w of aset) if (bset.has(w)) matches++
  const shorter = Math.min(aset.size, bset.size)
  // Short terms (≤2 distinctive stems): require ALL to match.
  if (shorter <= 2) return matches === shorter
  return matches >= 2 && matches / shorter >= 0.6
}

// True if one normalized string is a character-subsequence of the other
// (with ≥ 80% coverage of the shorter). Designed for id/label dedup where
// "newsubs_daily" should collapse with "New_Subscribers_Daily" even though
// the word sets don't overlap cleanly.
function labelsAreSubseq(a, b) {
  const na = normalizeText(a).replace(/\s+/g, '')
  const nb = normalizeText(b).replace(/\s+/g, '')
  if (!na || !nb) return false
  const [shorter, longer] = na.length <= nb.length ? [na, nb] : [nb, na]
  let si = 0
  for (let li = 0; li < longer.length && si < shorter.length; li++) {
    if (longer[li] === shorter[si]) si++
  }
  return si / shorter.length >= 0.8
}

// Find the FIRST item whose text/label is a near-duplicate of the candidate.
function findNearDupText(list, candidate, field = 'text') {
  if (!candidate) return null
  const nc = normalizeText(candidate)
  if (!nc) return null
  // Normalized equality is the strong signal (cheapest, always fires first).
  const exact = list.find(item => normalizeText(item[field] || '') === nc)
  if (exact) return exact
  for (const item of list) {
    if (textsAreNearDup(item[field] || '', candidate)) return item
  }
  return null
}

// ── Renderers ────────────────────────────────────────────────────────────
// Each turns structured data into the markdown the user sees. Keep outputs
// identical (or close) to what the prompt-driven system produces, so the
// visual rendering in the web app stays consistent.

function renderPeople(data) {
  const { people = [] } = data
  if (!people.length) {
    return `# People\n\nTeam members, roles, ownership.\n`
  }

  const nodeShape = {
    person: (id, label) => `  ${id}(["${label}"]):::person`,
    manager: (id, label) => `  ${id}(["${label}"]):::manager`,
    stakeholder: (id, label) => `  ${id}[/"${label}"\\]:::stakeholder`,
    team: (id, label) => `  ${id}[("${label}")]:::team`,
    vendor: (id, label) => `  ${id}[/"${label}"/]:::vendor`
  }

  const lines = []
  lines.push(`# People`, ``, `## Org Chart`, ``, '```mermaid', 'flowchart TD')

  for (const p of people) {
    const label = p.role ? `${p.name}<br/>${p.role}` : p.name
    const shape = nodeShape[p.kind] || nodeShape.person
    lines.push(shape(p.id, label))
  }

  // Reporting lines
  for (const p of people) {
    for (const mgrId of p.reports_to || []) {
      lines.push(`  ${mgrId} --> ${p.id}`)
    }
  }

  // classDefs
  lines.push(
    `  classDef person fill:#FAF6F0,stroke:#B8A88F,stroke-width:1.5px,color:#0F0A0A`,
    `  classDef manager fill:#F5EFE6,stroke:#9F8C70,stroke-width:1.5px,color:#0F0A0A`,
    `  classDef stakeholder fill:#F4F0EA,stroke:#A89887,stroke-width:1.5px,stroke-dasharray:4 3,color:#0F0A0A`,
    `  classDef team fill:#FBEBEB,stroke:#C28080,stroke-width:1.5px,color:#0F0A0A`,
    `  classDef vendor fill:#F2EBF5,stroke:#A18BB5,stroke-width:1.5px,color:#0F0A0A`
  )
  lines.push('```', '')
  return lines.join('\n')
}

function renderPlaybook(data) {
  const { rules = [] } = data
  if (!rules.length) {
    return `# General Patterns and Docs\n\nHow work happens here. Processes, approval paths, unwritten rules, timing gotchas.\n`
  }
  const bySection = {}
  for (const r of rules) {
    const sec = r.section || 'General'
    if (!bySection[sec]) bySection[sec] = []
    bySection[sec].push(r)
  }
  const lines = [`# General Patterns and Docs`, ``]
  for (const [sec, list] of Object.entries(bySection)) {
    lines.push(`## ${sec}`, '')
    for (const r of list) lines.push(`- ${r.text}`)
    lines.push('')
  }
  return lines.join('\n')
}

function renderEnvironment(data) {
  const { entries = [] } = data
  if (!entries.length) {
    return `# Files, Locations & Keys\n\nSFMC IDs, DE names, journey/automation keys, technical config.\n`
  }
  const lines = [`# Files, Locations & Keys`, ``]
  for (const e of entries) {
    const note = e.note ? ` — ${e.note}` : ''
    lines.push(`- **${e.key}**: ${e.value}${note}`)
  }
  lines.push('')
  return lines.join('\n')
}

function renderDecisions(data) {
  const { decisions = [], actions = [] } = data
  const lines = [`# Decisions & Actions`, ``, `## Decisions`, '']
  if (decisions.length) {
    for (const d of decisions) {
      const owner = d.owner ? ` _(${d.owner})_` : ''
      const superseded = d.superseded_by ? ' ~~(superseded)~~' : ''
      lines.push(`- ${d.text}${owner}${superseded}`)
    }
  } else {
    lines.push('_(none yet)_')
  }
  lines.push('', `## Actions`, '')
  if (actions.length) {
    for (const a of actions) {
      const owner = a.owner ? ` _(${a.owner})_` : ''
      const due = a.due ? ` — due ${a.due}` : ''
      const mark = a.done ? '[x]' : '[ ]'
      lines.push(`- ${mark} ${a.text}${owner}${due}`)
    }
  } else {
    lines.push('_(none yet)_')
  }
  lines.push('')
  return lines.join('\n')
}

function renderMyNotes(data) {
  const text = (data && data.text) || ''
  return text.trim() ? `# My Notes\n\n${text}\n` : `# My Notes\n`
}

// Architecture renderer — reproduces the SFMC visual vocabulary:
// floating annotation labels next to each technical node, optional layer
// subgraphs grouping related nodes, and the full classDef block.
const ARCH_KINDS = ['de', 'deSource', 'sql', 'automation', 'journey', 'email', 'cloudpage', 'decision', 'endpoint']

const ARCH_NODE_SHAPE = {
  de:        (id, label) => `    ${id}[("💾 ${label}")]:::de`,
  deSource:  (id, label) => `    ${id}[("💾 ${label}")]:::deSource`,
  sql:       (id, label) => `    ${id}[["🔍 ${label}"]]:::sql`,
  automation:(id, label) => `    ${id}{{"⚙️ ${label}"}}:::automation`,
  journey:   (id, label) => `    ${id}(["⚡ ${label}"]):::journey`,
  email:     (id, label) => `    ${id}[/"📧 ${label}"/]:::email`,
  cloudpage: (id, label) => `    ${id}[\\"🌐 ${label}"\\]:::cloudpage`,
  decision:  (id, label) => `    ${id}{"🔀 ${label}"}:::decision`,
  endpoint:  (id, label) => `    ${id}(["${label}"]):::endpoint`
}

const ARCH_CLASSDEFS = [
  `  classDef de fill:#F2F6FA,stroke:#7FA0BD,stroke-width:1.5px,color:#0F0A0A`,
  `  classDef deSource fill:#EAF1F7,stroke:#7FA0BD,stroke-width:1.5px,color:#0F0A0A`,
  `  classDef sql fill:#FCF8E8,stroke:#C9B864,stroke-width:1.5px,color:#0F0A0A`,
  `  classDef automation fill:#F4F1EC,stroke:#A89887,stroke-width:1.5px,color:#0F0A0A`,
  `  classDef journey fill:#FBEBEB,stroke:#C28080,stroke-width:1.5px,color:#0F0A0A`,
  `  classDef email fill:#FAF1E5,stroke:#C9A878,stroke-width:1.5px,color:#0F0A0A`,
  `  classDef cloudpage fill:#F2EBF5,stroke:#A18BB5,stroke-width:1.5px,color:#0F0A0A`,
  `  classDef decision fill:#FFFFFF,stroke:#8F0000,stroke-width:2px,color:#0F0A0A`,
  `  classDef endpoint fill:#FFFFFF,stroke:#888,stroke-width:1.5px,color:#0F0A0A`,
  `  classDef note fill:transparent,stroke:transparent,color:#6B5A5A,font-style:italic,font-size:12px`
]

function renderArchitecture(data) {
  const { prose = '', nodes = [], edges = [], layers = [] } = data
  const lines = []

  if (prose && prose.trim()) {
    lines.push('## How it works', '', prose.trim(), '')
  }
  lines.push('## Diagram', '', '```mermaid', 'flowchart TD')

  if (!nodes.length) {
    lines.push('  empty["(empty diagram — add nodes via typed ops)"]:::endpoint')
    lines.push(...ARCH_CLASSDEFS, '```', '')
    return lines.join('\n')
  }

  // Each node lives in its own pair_<id> subgraph with a floating note.
  const renderPair = (n) => {
    const shape = ARCH_NODE_SHAPE[n.kind] || ARCH_NODE_SHAPE.endpoint
    const out = [`  subgraph pair_${n.id} [" "]`, `    direction LR`, shape(n.id, n.label || n.id)]
    if (n.note) out.push(`    ${n.id}_note["${n.note}"]:::note`)
    out.push(`  end`)
    return out.join('\n')
  }

  const nodesByLayer = {}
  const orphans = []
  for (const n of nodes) {
    if (n.layer && layers.find(l => l.id === n.layer)) {
      if (!nodesByLayer[n.layer]) nodesByLayer[n.layer] = []
      nodesByLayer[n.layer].push(n)
    } else {
      orphans.push(n)
    }
  }

  for (const layer of layers) {
    const members = nodesByLayer[layer.id] || []
    if (!members.length) continue
    lines.push(`  subgraph layer_${layer.id} ["${layer.title}"]`)
    for (const n of members) lines.push(renderPair(n))
    lines.push(`  end`)
  }
  for (const n of orphans) lines.push(renderPair(n))

  // Edges
  for (const e of edges) {
    const lab = e.label ? `|${e.label}|` : ''
    lines.push(`  ${e.from} -->${lab} ${e.to}`)
  }

  // Styles for layer + pair subgraphs (transparent containers)
  for (const layer of layers) {
    if ((nodesByLayer[layer.id] || []).length) {
      lines.push(`  style layer_${layer.id} fill:transparent,stroke:#E8D8D2,stroke-dasharray:4 4`)
    }
  }
  for (const n of nodes) lines.push(`  style pair_${n.id} fill:transparent,stroke:transparent`)

  lines.push(...ARCH_CLASSDEFS, '```', '')
  return lines.join('\n')
}

const RENDERERS = {
  'people.md': renderPeople,
  'playbook.md': renderPlaybook,
  'environment.md': renderEnvironment,
  'decisions.md': renderDecisions,
  'my-notes.md': renderMyNotes,
  'architecture': renderArchitecture
}

export function render(filename, data) {
  const fn = RENDERERS[filename]
  if (!fn) throw new Error(`No renderer for ${filename}`)
  return fn(data || emptyData(filename))
}

// ── Op handlers ──────────────────────────────────────────────────────────
// Each op: (data, args) => newData. Throw on invalid args.
// data is the CURRENT structured data; return a new object (immutable style).

const OPS = {
  // People
  add_person(data, { name, role, kind = 'person', reports_to }) {
    if (!name) throw new Error('name required')
    if (!['person', 'manager', 'stakeholder', 'team', 'vendor'].includes(kind)) {
      throw new Error(`invalid kind: ${kind}`)
    }
    const people = [...(data.people || [])]
    if (findByName(people, name)) throw new Error(`${name} already exists`)
    const person = ensureId({ name, role, kind, reports_to: [] }, 'p')
    if (reports_to) {
      const mgr = findByName(people, reports_to)
      if (mgr) person.reports_to = [mgr.id]
    }
    people.push(person)
    return { ...data, people }
  },
  set_role(data, { person, role }) {
    const target = findByName(data.people || [], person)
    if (!target) throw new Error(`unknown person: ${person}`)
    const people = (data.people || []).map(p =>
      p.id === target.id ? { ...p, role } : p
    )
    return { ...data, people }
  },
  remove_person(data, { name }) {
    const target = findByName(data.people || [], name)
    if (!target) return data
    const people = (data.people || []).filter(p => p.id !== target.id)
      .map(p => ({ ...p, reports_to: (p.reports_to || []).filter(id => id !== target.id) }))
    return { ...data, people }
  },
  add_reporting_line(data, { from, to }) {
    // `from` reports to `to` (to is the manager). We store reports_to on from.
    const fromP = findByName(data.people || [], from)
    const toP = findByName(data.people || [], to)
    if (!fromP || !toP) throw new Error(`unknown person: ${!fromP ? from : to}`)
    const people = (data.people || []).map(p => p.id === fromP.id
      ? { ...p, reports_to: Array.from(new Set([...(p.reports_to || []), toP.id])) }
      : p
    )
    return { ...data, people }
  },
  remove_reporting_line(data, { from, to }) {
    const fromP = findByName(data.people || [], from)
    const toP = findByName(data.people || [], to)
    if (!fromP || !toP) throw new Error(`unknown person: ${!fromP ? from : to}`)
    const people = (data.people || []).map(p => p.id === fromP.id
      ? { ...p, reports_to: (p.reports_to || []).filter(id => id !== toP.id) }
      : p
    )
    return { ...data, people }
  },
  // Replace ALL of `person`'s managers with the single named manager.
  // For "X reports to Y instead of Z" — the LLM doesn't have to know Z by name.
  set_manager(data, { person, manager }) {
    const personP = findByName(data.people || [], person)
    const mgrP = findByName(data.people || [], manager)
    if (!personP || !mgrP) throw new Error(`unknown person: ${!personP ? person : manager}`)
    const people = (data.people || []).map(p => p.id === personP.id
      ? { ...p, reports_to: [mgrP.id] }
      : p
    )
    return { ...data, people }
  },

  // Playbook
  add_playbook_rule(data, { text, section }) {
    if (!text) throw new Error('text required')
    // Only LIVE rules (not already superseded) block new adds. If an older
    // rule has been explicitly superseded, a fresh rule on the same topic
    // is legitimate (e.g. policy flips back after a flip-flop).
    const liveRules = (data.rules || []).filter(r => !r.superseded_by)
    const dup = findNearDupText(liveRules, text, 'text')
    if (dup) {
      throw new Error(`Near-duplicate playbook rule already exists: "${dup.text}" (${dup.id}). If this supersedes it, call supersede_rule; otherwise skip.`)
    }
    const rules = [...(data.rules || []), { id: `r_${Math.random().toString(36).slice(2, 7)}`, text, section: section || null }]
    return { ...data, rules }
  },
  remove_playbook_rule(data, { id }) {
    return { ...data, rules: (data.rules || []).filter(r => r.id !== id) }
  },
  // Mark an old rule as superseded and add a new one linked to it — preserves
  // audit trail ("the policy used to be X, now it's Y") instead of silently
  // deleting or creating contradictions.
  supersede_rule(data, { id, new_text, section }) {
    if (!id || !new_text) throw new Error('id and new_text required')
    const rules = data.rules || []
    const old = rules.find(r => r.id === id)
    if (!old) throw new Error(`unknown rule: ${id}`)
    const newId = `r_${Math.random().toString(36).slice(2, 7)}`
    const updated = rules.map(r => r.id === id ? { ...r, superseded_by: newId } : r)
    updated.push({ id: newId, text: new_text, section: section || old.section || null, supersedes: id })
    return { ...data, rules: updated }
  },

  // Environment
  set_environment_key(data, { key, value, note }) {
    if (!key) throw new Error('key required')
    const entries = [...(data.entries || [])]
    const i = entries.findIndex(e => e.key === key)
    if (i >= 0) {
      entries[i] = { ...entries[i], value, ...(note !== undefined ? { note } : {}) }
    } else {
      // Near-dup KEY check: "org_name" vs "organization_name" with the same
      // value is noise. Normalize both keys (strip _, lowercase) and check.
      const normKey = key.toLowerCase().replace(/[_\-\s]+/g, '')
      const dupByKey = entries.find(e => {
        const nk = e.key.toLowerCase().replace(/[_\-\s]+/g, '')
        return nk === normKey
      })
      if (dupByKey) {
        throw new Error(`Near-duplicate environment key: "${dupByKey.key}" already exists (normalized both to "${normKey}"). Update the existing key or use a distinct name.`)
      }
      // Same-value check: two different keys storing identical values is
      // usually accidental — "org_name" and "company" both = "Riverside".
      if (value) {
        const dupByVal = entries.find(e => e.value === value && e.key !== key)
        if (dupByVal) {
          throw new Error(`Environment key "${dupByVal.key}" already stores the same value "${value}". Reuse that key or pick a meaningfully different one.`)
        }
      }
      entries.push({ key, value, note: note || null })
    }
    return { ...data, entries }
  },
  remove_environment_key(data, { key }) {
    return { ...data, entries: (data.entries || []).filter(e => e.key !== key) }
  },

  // Decisions
  add_decision(data, { text, owner }) {
    if (!text) throw new Error('text required')
    const existing = (data.decisions || []).filter(d => !d.superseded_by)  // only live decisions block adds
    const dup = findNearDupText(existing, text, 'text')
    if (dup) {
      throw new Error(`Near-duplicate decision already exists: "${dup.text}" (${dup.id}). If this replaces it (e.g. user said "scratch that" / "instead"), call supersede_decision; otherwise skip.`)
    }
    const decisions = [...(data.decisions || []), { id: `d_${Math.random().toString(36).slice(2, 7)}`, text, owner: owner || null }]
    return { ...data, decisions }
  },
  add_action(data, { text, owner, due }) {
    if (!text) throw new Error('text required')
    // Dedup on open (not-done) actions only. If the user previously logged
    // "Casey tests validation rule in dev" and marked it done, a new action
    // with the same text may legitimately represent a new cycle. But two
    // open duplicates are always noise.
    const open = (data.actions || []).filter(a => !a.done)
    const dup = findNearDupText(open, text, 'text')
    if (dup) {
      throw new Error(`Near-duplicate open action already exists: "${dup.text}" (${dup.id}). If this is completing it, call complete_action_by_text; otherwise skip.`)
    }
    const actions = [...(data.actions || []), { id: `a_${Math.random().toString(36).slice(2, 7)}`, text, owner: owner || null, due: due || null, done: false }]
    return { ...data, actions }
  },
  complete_action(data, { id }) {
    return { ...data, actions: (data.actions || []).map(a => a.id === id ? { ...a, done: true } : a) }
  },
  // Resolve an action by fuzzy text match — for "I finished the bucket setup".
  // Matches the action whose text contains all the meaningful words from `text`.
  complete_action_by_text(data, { text }) {
    if (!text) throw new Error('text required')
    const words = text.toLowerCase().split(/\W+/).filter(w => w.length > 3)
    const actions = data.actions || []
    const match = actions.find(a => {
      const lower = (a.text || '').toLowerCase()
      return words.every(w => lower.includes(w))
    })
    if (!match) throw new Error(`no action matches "${text}"`)
    return { ...data, actions: actions.map(a => a.id === match.id ? { ...a, done: true } : a) }
  },
  remove_decision(data, { id }) {
    return { ...data, decisions: (data.decisions || []).filter(d => d.id !== id) }
  },
  // Mark a decision as superseded by a new one. Preserves the audit trail
  // ("we decided X, then later decided Y") instead of silently deleting.
  supersede_decision(data, { id, new_text, owner }) {
    if (!id || !new_text) throw new Error('id and new_text required')
    const decisions = data.decisions || []
    const old = decisions.find(d => d.id === id)
    if (!old) throw new Error(`unknown decision: ${id}`)
    const newId = `d_${Math.random().toString(36).slice(2, 7)}`
    const updated = decisions.map(d => d.id === id
      ? { ...d, superseded_by: newId }
      : d
    )
    updated.push({ id: newId, text: new_text, owner: owner || null, supersedes: id })
    return { ...data, decisions: updated }
  },

  // ── Architecture ──────────────────────────────────────────────────
  set_prose(data, { text }) {
    return { ...data, prose: text || '' }
  },
  add_node(data, { id, label, kind, note, layer }) {
    if (!id) throw new Error('id required')
    if (!ARCH_KINDS.includes(kind)) throw new Error(`invalid kind: ${kind}. Use one of ${ARCH_KINDS.join(', ')}`)
    const nodes = [...(data.nodes || [])]
    if (nodes.find(n => n.id === id)) throw new Error(`node ${id} already exists`)
    // LABEL-level dedup, KIND-AWARE. Two nodes of different kinds (e.g. a
    // deSource DE and an Automation) can't be duplicates of each other —
    // they're different SFMC objects even if labels overlap ("Populi_Master"
    // DE + "Populi_Sync_Auto" automation). Previously the dedup was kind-
    // blind and rejected legitimate different-kind adds, producing orphan
    // edges whose node rows never landed (see sfmc-cross-bu-trap crit from
    // this morning's overnight).
    const effLabel = label || id
    const dup = nodes.find(n => {
      if (n.kind !== kind) return false
      const nLabel = n.label || n.id
      return normalizeText(nLabel) === normalizeText(effLabel)
          || normalizeText(n.id) === normalizeText(id)
          || labelsAreSubseq(nLabel, effLabel)
          || labelsAreSubseq(n.id, id)
    })
    if (dup) {
      throw new Error(`Near-duplicate architecture node already exists: "${dup.label}" (${dup.id}, kind:${dup.kind}). Reuse that id for edges, or call merge_nodes if you meant to consolidate.`)
    }
    nodes.push({ id, label: effLabel, kind, note: note || null, layer: layer || null })
    return { ...data, nodes }
  },
  set_node_label(data, { id, label }) {
    const nodes = (data.nodes || []).map(n => n.id === id ? { ...n, label } : n)
    return { ...data, nodes }
  },
  set_node_note(data, { id, note }) {
    const nodes = (data.nodes || []).map(n => n.id === id ? { ...n, note: note || null } : n)
    return { ...data, nodes }
  },
  set_node_kind(data, { id, kind }) {
    if (!ARCH_KINDS.includes(kind)) throw new Error(`invalid kind: ${kind}`)
    const nodes = (data.nodes || []).map(n => n.id === id ? { ...n, kind } : n)
    return { ...data, nodes }
  },
  move_node_to_layer(data, { id, layer }) {
    const nodes = (data.nodes || []).map(n => n.id === id ? { ...n, layer: layer || null } : n)
    return { ...data, nodes }
  },
  remove_node(data, { id }) {
    const nodes = (data.nodes || []).filter(n => n.id !== id)
    const edges = (data.edges || []).filter(e => e.from !== id && e.to !== id)
    return { ...data, nodes, edges }
  },
  // Collapse a duplicate into a canonical node. Rewrites every edge that
  // referenced `remove_id` to point at `keep_id`, then drops the dup row.
  // Dedup-safe: resulting duplicate edges (same from→to, same label) are
  // collapsed so we don't trade one kind of noise for another.
  merge_nodes(data, { keep_id, remove_id }) {
    if (!keep_id || !remove_id) throw new Error('keep_id and remove_id required')
    if (keep_id === remove_id) throw new Error('keep_id and remove_id must differ')
    const nodes = data.nodes || []
    if (!nodes.find(n => n.id === keep_id)) throw new Error(`unknown node: ${keep_id}`)
    if (!nodes.find(n => n.id === remove_id)) throw new Error(`unknown node: ${remove_id}`)
    const rewritten = (data.edges || []).map(e => ({
      from: e.from === remove_id ? keep_id : e.from,
      to:   e.to   === remove_id ? keep_id : e.to,
      label: e.label || null
    })).filter(e => e.from !== e.to)   // drop self-loops created by the merge
    const seen = new Set()
    const edges = []
    for (const e of rewritten) {
      const key = `${e.from}→${e.to}|${e.label || ''}`
      if (seen.has(key)) continue
      seen.add(key); edges.push(e)
    }
    return {
      ...data,
      nodes: nodes.filter(n => n.id !== remove_id),
      edges
    }
  },
  add_edge(data, { from, to, label }) {
    if (!from || !to) throw new Error('from and to required')
    // Referential integrity: edges can only reference nodes that exist in the
    // current nodes array. Previously a rejected add_node (e.g. via dedup)
    // could leave edges hanging in the diagram pointing at ids that never
    // landed in the nodes array, producing an un-renderable graph. Reject
    // here and force the caller to add the node first.
    const nodes = data.nodes || []
    if (!nodes.find(n => n.id === from)) {
      throw new Error(`edge from "${from}" — no such node. Call add_node for "${from}" first, then retry this edge.`)
    }
    if (!nodes.find(n => n.id === to)) {
      throw new Error(`edge to "${to}" — no such node. Call add_node for "${to}" first, then retry this edge.`)
    }
    const existing = (data.edges || [])
    const normLabel = label || null
    // Dedup: reject exact-duplicate (from, to, label) — architecture-heavy
    // narrative flagged three identical inbound edges on the same node.
    const dup = existing.find(e => e.from === from && e.to === to && (e.label || null) === normLabel)
    if (dup) {
      throw new Error(`Edge ${from} → ${to}${normLabel ? ` [${normLabel}]` : ''} already exists. Don't re-add the same relationship.`)
    }
    // Same-label reverse-direction warning: A → B "sync" and then B → A "sync"
    // usually means the LLM triple-fired on one relationship. Distinct-label
    // reverse edges ("queries" + "read by") are legitimate.
    if (normLabel) {
      const reverse = existing.find(e => e.from === to && e.to === from && (e.label || null) === normLabel)
      if (reverse) {
        throw new Error(`Edge ${from} → ${to} [${normLabel}] contradicts existing reverse edge ${to} → ${from} [${normLabel}]. Data flows one direction — remove the wrong one or use distinct labels.`)
      }
    }
    const edges = [...existing, { from, to, label: normLabel }]
    return { ...data, edges }
  },
  remove_edge(data, { from, to }) {
    const edges = (data.edges || []).filter(e => !(e.from === from && e.to === to))
    return { ...data, edges }
  },
  add_layer(data, { id, title }) {
    if (!id || !title) throw new Error('id and title required')
    const layers = [...(data.layers || [])]
    if (layers.find(l => l.id === id)) throw new Error(`layer ${id} already exists`)
    layers.push({ id, title })
    return { ...data, layers }
  },
  remove_layer(data, { id }) {
    const layers = (data.layers || []).filter(l => l.id !== id)
    // Promote orphaned nodes to no-layer
    const nodes = (data.nodes || []).map(n => n.layer === id ? { ...n, layer: null } : n)
    return { ...data, layers, nodes }
  },

  // My Notes (free-form)
  append_my_note(data, { text }) {
    if (!text) throw new Error('text required')
    const prev = (data.text || '').trim()
    return { ...data, text: prev ? `${prev}\n\n${text}` : text }
  },
  replace_my_notes(data, { text }) {
    return { ...data, text: text || '' }
  }
}

// Which op names are valid for which tab?
export const OPS_BY_TAB = {
  'people.md': ['add_person', 'set_role', 'remove_person', 'add_reporting_line', 'remove_reporting_line', 'set_manager'],
  'playbook.md': ['add_playbook_rule', 'remove_playbook_rule', 'supersede_rule'],
  'environment.md': ['set_environment_key', 'remove_environment_key'],
  'decisions.md': ['add_decision', 'add_action', 'complete_action', 'complete_action_by_text', 'remove_decision', 'supersede_decision'],
  'my-notes.md': ['append_my_note', 'replace_my_notes'],
  'architecture': ['set_prose', 'add_node', 'set_node_label', 'set_node_note', 'set_node_kind', 'move_node_to_layer', 'remove_node', 'merge_nodes', 'add_edge', 'remove_edge', 'add_layer', 'remove_layer']
}

export function listOps() {
  return Object.keys(OPS)
}

export function applyOp(filename, data, op, args) {
  const fn = OPS[op]
  if (!fn) throw new Error(`unknown op: ${op}`)
  const validOps = OPS_BY_TAB[filename] || []
  if (!validOps.includes(op)) throw new Error(`op "${op}" not valid for tab "${filename}"`)
  const safeData = data || emptyData(filename)
  return fn(safeData, args || {})
}

// Apply a batch of ops. Returns { data, applied: [{op, args}], errors: [{op, msg}] }.
// Continues past individual failures so one bad op doesn't lose the rest.
export function applyOps(filename, data, ops) {
  let cur = data || emptyData(filename)
  const applied = []
  const errors = []
  for (const o of ops || []) {
    try {
      cur = applyOp(filename, cur, o.op, o.args)
      applied.push(o)
    } catch (err) {
      errors.push({ op: o.op, msg: err.message })
    }
  }
  return { data: cur, applied, errors }
}
