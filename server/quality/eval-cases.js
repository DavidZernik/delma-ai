// Canonical eval cases — shared between scripts/eval-router.js (CLI) and
// server/quality/runner.js (scheduled). Each case is { name, input, tabs,
// expect: [{desc, check}] } where check(ops, finalData) returns boolean.
//
// Adding a case here makes it run in BOTH the manual eval and the nightly
// regression suite. That's deliberate — one source of truth.

import { ROUTER_SYSTEM_PROMPT, buildTabsBlock, buildRouterUserMessage } from '../../src/router-prompt.js'
import { extractJsonArray } from '../../src/extract-json-array.js'
import { applyOp, emptyData } from '../../src/tab-ops.js'

const tabKey = {
  people: 'org:people.md', playbook: 'org:playbook.md',
  environment: 'memory:environment.md', decisions: 'memory:decisions.md',
  myNotes: 'memory:my-notes.md', architecture: 'diagram:architecture'
}

const titles = {
  [tabKey.people]: 'People', [tabKey.playbook]: 'Playbook',
  [tabKey.environment]: 'Files, Locations & Keys', [tabKey.decisions]: 'Decisions & Actions',
  [tabKey.myNotes]: 'My Notes', [tabKey.architecture]: 'Architecture'
}

function tab(key, structured = null) {
  const filename = key.split(':')[1]
  return { key, title: titles[key] || key, structured: structured ?? emptyData(filename), content: '' }
}

const seededPeople = {
  people: [{ id: 'p_keyona', name: 'Keyona Abbott', role: 'Manager / PM', kind: 'manager', reports_to: [] }]
}

const seededArch = {
  prose: 'The DailyAuto runs at 5am and triggers the WelcomeJourney.',
  layers: [{ id: 'filter', title: 'Daily Filter' }],
  nodes: [
    { id: 'DailyAuto', label: 'Birthday_Daily_Send_Refresh', kind: 'automation', note: 'kicks off every morning', layer: 'filter' },
    { id: 'WelcomeJourney', label: 'Welcome Journey', kind: 'journey', note: 'sends greeting email', layer: null }
  ],
  edges: [{ from: 'DailyAuto', to: 'WelcomeJourney', label: null }]
}

export const CASES = [
  // (Subset of scripts/eval-router.js cases — the ones safe to run unattended.
  // Anything that requires network access beyond Anthropic stays out.)
  {
    name: 'people-add-person-with-report',
    input: 'add David as an engineer reporting to Keyona',
    tabs: [tab(tabKey.people, seededPeople)],
    expect: [
      { desc: 'emits add_person on people tab', check: (ops) => ops.some(o => o.tab === tabKey.people && o.op === 'add_person') },
      { desc: 'David reports to Keyona', check: (_o, d) => {
        const david = d[tabKey.people]?.people?.find(p => /David/i.test(p.name))
        return !!david && (david.reports_to || []).includes('p_keyona')
      } }
    ]
  },
  {
    name: 'env-set-key',
    input: 'our sender profile ID is SP_Emory_Main',
    tabs: [tab(tabKey.environment), tab(tabKey.people, seededPeople)],
    expect: [
      { desc: 'set_environment_key emitted', check: (ops) => ops.some(o => o.tab === tabKey.environment && o.op === 'set_environment_key') },
      { desc: 'no people-tab change', check: (ops) => !ops.some(o => o.tab === tabKey.people) }
    ]
  },
  {
    name: 'decision-add',
    input: 'we decided to use the pooler URL for migrations',
    tabs: [tab(tabKey.decisions)],
    expect: [{ desc: 'add_decision emitted', check: (ops) => ops.some(o => o.op === 'add_decision') }]
  },
  {
    name: 'irrelevant-input',
    input: "what's for lunch",
    tabs: [tab(tabKey.people, seededPeople), tab(tabKey.decisions)],
    expect: [{ desc: 'returns empty ops', check: (ops) => ops.length === 0 }]
  },
  {
    name: 'set-manager-replaces',
    input: 'David should report to Sarah, not Keyona',
    tabs: [tab(tabKey.people, {
      people: [
        { id: 'p_keyona', name: 'Keyona Abbott', role: 'PM', kind: 'manager', reports_to: [] },
        { id: 'p_sarah', name: 'Sarah Lee', role: 'Lead', kind: 'manager', reports_to: [] },
        { id: 'p_david', name: 'David Zernik', role: 'Engineer', kind: 'person', reports_to: ['p_keyona'] }
      ]
    })],
    expect: [{ desc: 'David ends up reporting to Sarah only', check: (_o, d) => {
      const david = d[tabKey.people]?.people?.find(p => /David/i.test(p.name))
      const sarah = d[tabKey.people]?.people?.find(p => /Sarah/i.test(p.name))
      return david && sarah && (david.reports_to || []).includes(sarah.id) && !(david.reports_to || []).includes('p_keyona')
    } }]
  },
  {
    name: 'arch-add-email-and-edge',
    input: 'add a Welcome email asset wired off the WelcomeJourney',
    tabs: [tab(tabKey.architecture, seededArch)],
    expect: [
      { desc: 'add_node email', check: (ops) => ops.some(o => o.tab === tabKey.architecture && o.op === 'add_node' && o.args?.kind === 'email') },
      { desc: 'edge from WelcomeJourney to new email', check: (_o, d) => {
        const email = d[tabKey.architecture]?.nodes?.find(n => n.kind === 'email')
        if (!email) return false
        return d[tabKey.architecture]?.edges?.some(e => e.from === 'WelcomeJourney' && e.to === email.id)
      } }
    ]
  }
]

// ── Runner — calls the prompt and applies returned ops to seeded state ──

async function callRouter(input, tabs, { model = 'claude-haiku-4-5', system = ROUTER_SYSTEM_PROMPT } = {}) {
  const tabsBlock = buildTabsBlock(tabs)
  const user = buildRouterUserMessage(input, tabsBlock)
  const t0 = Date.now()
  const res = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-api-key': process.env.ANTHROPIC_API_KEY, 'anthropic-version': '2023-06-01' },
    body: JSON.stringify({ model, max_tokens: 2000, system, messages: [{ role: 'user', content: user }] })
  })
  if (!res.ok) throw new Error(`Anthropic ${res.status}: ${await res.text()}`)
  const data = await res.json()
  const raw = data.content?.[0]?.text?.trim() || '[]'
  return { ops: extractJsonArray(raw), raw, ms: Date.now() - t0 }
}

function applyAll(seededTabs, ops) {
  const byKey = Object.fromEntries(seededTabs.map(t => [t.key, t.structured]))
  for (const o of ops || []) {
    if (!byKey[o.tab]) continue
    const filename = o.tab.split(':')[1]
    try { byKey[o.tab] = applyOp(filename, byKey[o.tab], o.op, o.args || {}) }
    catch { /* skip */ }
  }
  return byKey
}

export async function runCases(cases, opts = {}) {
  const out = []
  for (const c of cases) {
    try {
      const { ops, raw, ms } = await callRouter(c.input, c.tabs, opts)
      const finalData = applyAll(c.tabs, ops)
      const checks = c.expect.map(e => {
        try { return { desc: e.desc, ok: !!e.check(ops, finalData) } }
        catch (err) { return { desc: e.desc, ok: false } }
      })
      out.push({ name: c.name, pass: checks.every(c => c.ok), checks, ms, ops, raw })
    } catch (err) {
      out.push({ name: c.name, pass: false, checks: [], ms: 0, ops: [], raw: '', error: err.message })
    }
  }
  return out
}
