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
  'my-notes.md': () => ({ text: '' })
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
      lines.push(`- ${d.text}${owner}`)
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

const RENDERERS = {
  'people.md': renderPeople,
  'playbook.md': renderPlaybook,
  'environment.md': renderEnvironment,
  'decisions.md': renderDecisions,
  'my-notes.md': renderMyNotes
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
    const rules = [...(data.rules || []), { id: `r_${Math.random().toString(36).slice(2, 7)}`, text, section: section || null }]
    return { ...data, rules }
  },
  remove_playbook_rule(data, { id }) {
    return { ...data, rules: (data.rules || []).filter(r => r.id !== id) }
  },

  // Environment
  set_environment_key(data, { key, value, note }) {
    if (!key) throw new Error('key required')
    const entries = [...(data.entries || [])]
    const i = entries.findIndex(e => e.key === key)
    if (i >= 0) entries[i] = { ...entries[i], value, ...(note !== undefined ? { note } : {}) }
    else entries.push({ key, value, note: note || null })
    return { ...data, entries }
  },
  remove_environment_key(data, { key }) {
    return { ...data, entries: (data.entries || []).filter(e => e.key !== key) }
  },

  // Decisions
  add_decision(data, { text, owner }) {
    if (!text) throw new Error('text required')
    const decisions = [...(data.decisions || []), { id: `d_${Math.random().toString(36).slice(2, 7)}`, text, owner: owner || null }]
    return { ...data, decisions }
  },
  add_action(data, { text, owner, due }) {
    if (!text) throw new Error('text required')
    const actions = [...(data.actions || []), { id: `a_${Math.random().toString(36).slice(2, 7)}`, text, owner: owner || null, due: due || null, done: false }]
    return { ...data, actions }
  },
  complete_action(data, { id }) {
    return { ...data, actions: (data.actions || []).map(a => a.id === id ? { ...a, done: true } : a) }
  },
  remove_decision(data, { id }) {
    return { ...data, decisions: (data.decisions || []).filter(d => d.id !== id) }
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
  'playbook.md': ['add_playbook_rule', 'remove_playbook_rule'],
  'environment.md': ['set_environment_key', 'remove_environment_key'],
  'decisions.md': ['add_decision', 'add_action', 'complete_action', 'remove_decision'],
  'my-notes.md': ['append_my_note', 'replace_my_notes']
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
