#!/usr/bin/env node
// Router eval harness (v2 — typed ops).
//
// Runs natural-language inputs against the same router prompt the live app
// uses, with SEEDED tab state (no Supabase writes). The router now returns
// TYPED OPERATIONS; this harness applies them via the pure tab-ops module
// and asserts on both the ops list AND the resulting structured data.
//
// Usage:
//   node scripts/eval-router.js
//   node scripts/eval-router.js --case=people-*
//   node scripts/eval-router.js --verbose

import { config as loadEnv } from 'dotenv'
loadEnv({ override: true })
import { ROUTER_SYSTEM_PROMPT, buildTabsBlock, buildRouterUserMessage } from '../src/router-prompt.js'
import { extractJsonArray } from '../src/extract-json-array.js'
import { applyOp, emptyData } from '../src/tab-ops.js'

const MODEL = 'claude-haiku-4-5'
const ANTHROPIC_URL = 'https://api.anthropic.com/v1/messages'

if (!process.env.ANTHROPIC_API_KEY) {
  console.error('ANTHROPIC_API_KEY not set in .env')
  process.exit(1)
}

// ── Test cases ───────────────────────────────────────────────────────────
// Each case declares:
//   name       — short id
//   input      — user's NL input
//   tabs       — seeded tabs (each { key, title, structured })
//   expect     — assertions on the ops array + resulting data

const tabKey = {
  people: 'org:people.md',
  playbook: 'org:playbook.md',
  environment: 'memory:environment.md',
  decisions: 'memory:decisions.md',
  myNotes: 'memory:my-notes.md'
}

function tab(key, structured = null) {
  const title = {
    [tabKey.people]: 'People',
    [tabKey.playbook]: 'Playbook',
    [tabKey.environment]: 'Files, Locations & Keys',
    [tabKey.decisions]: 'Decisions & Actions',
    [tabKey.myNotes]: 'My Notes'
  }[key] || key
  const filename = key.split(':')[1]
  return { key, title, structured: structured ?? emptyData(filename), content: '' }
}

const seededPeople = {
  people: [
    { id: 'p_keyona', name: 'Keyona Abbott', role: 'Manager / PM', kind: 'manager', reports_to: [] }
  ]
}

const cases = [
  // ── People ──────────────────────────────────────────────────────────
  {
    name: 'people-add-person-with-report',
    input: 'add David as an engineer reporting to Keyona',
    tabs: [tab(tabKey.people, seededPeople)],
    expect: [
      { desc: 'emits add_person on people tab',
        check: (ops) => ops.some(o => o.tab === tabKey.people && o.op === 'add_person') },
      { desc: 'David added with role',
        check: (_ops, finalData) => {
          const d = finalData[tabKey.people]?.people?.find(p => /David/i.test(p.name))
          return !!d && /engineer/i.test(d.role || '')
        }
      },
      { desc: 'David reports to Keyona',
        check: (_ops, finalData) => {
          const d = finalData[tabKey.people]?.people?.find(p => /David/i.test(p.name))
          return !!d && (d.reports_to || []).includes('p_keyona')
        }
      }
    ]
  },
  {
    name: 'people-change-role',
    input: 'Keyona is actually the PM, not manager',
    tabs: [tab(tabKey.people, seededPeople)],
    expect: [
      { desc: 'emits set_role, not add_person',
        check: (ops) => ops.some(o => o.op === 'set_role') && !ops.some(o => o.op === 'add_person') },
      { desc: 'Keyona role updated',
        check: (_ops, finalData) => {
          const k = finalData[tabKey.people]?.people?.find(p => /Keyona/i.test(p.name))
          return !!k && /PM/i.test(k.role || '')
        }
      }
    ]
  },

  // ── Environment ─────────────────────────────────────────────────────
  {
    name: 'env-set-key',
    input: 'our sender profile ID is SP_Emory_Main',
    tabs: [tab(tabKey.environment), tab(tabKey.people, seededPeople)],
    expect: [
      { desc: 'emits set_environment_key on environment tab',
        check: (ops) => ops.some(o => o.tab === tabKey.environment && o.op === 'set_environment_key') },
      { desc: 'does NOT touch people tab',
        check: (ops) => !ops.some(o => o.tab === tabKey.people) },
      { desc: 'entry stored with correct key/value',
        check: (_ops, finalData) => {
          const e = finalData[tabKey.environment]?.entries?.find(x => /sender.*profile/i.test(x.key))
          return !!e && /SP_Emory_Main/.test(e.value)
        }
      }
    ]
  },

  // ── Playbook ────────────────────────────────────────────────────────
  {
    name: 'playbook-rule',
    input: 'we never launch sends on Fridays',
    tabs: [tab(tabKey.playbook), tab(tabKey.people, seededPeople)],
    expect: [
      { desc: 'emits add_playbook_rule',
        check: (ops) => ops.some(o => o.tab === tabKey.playbook && o.op === 'add_playbook_rule') },
      { desc: 'rule text mentions Friday',
        check: (_ops, finalData) => {
          const r = finalData[tabKey.playbook]?.rules || []
          return r.some(x => /friday/i.test(x.text))
        }
      }
    ]
  },

  // ── Decisions + Actions ─────────────────────────────────────────────
  {
    name: 'decision-add',
    input: 'we decided to use the pooler URL for migrations, not direct',
    tabs: [tab(tabKey.decisions), tab(tabKey.environment)],
    expect: [
      { desc: 'emits add_decision',
        check: (ops) => ops.some(o => o.tab === tabKey.decisions && o.op === 'add_decision') },
      { desc: 'decision mentions pooler',
        check: (_ops, finalData) => {
          const d = finalData[tabKey.decisions]?.decisions || []
          return d.some(x => /pooler/i.test(x.text))
        }
      }
    ]
  },
  {
    name: 'action-add',
    input: "todo: David needs to set up Supabase Storage bucket by Friday",
    tabs: [tab(tabKey.decisions)],
    expect: [
      { desc: 'emits add_action',
        check: (ops) => ops.some(o => o.op === 'add_action') },
      { desc: 'action has owner David',
        check: (_ops, finalData) => {
          const a = finalData[tabKey.decisions]?.actions || []
          return a.some(x => /david/i.test(x.owner || ''))
        }
      }
    ]
  },

  // ── My Notes (personal) ─────────────────────────────────────────────
  {
    name: 'my-notes-personal',
    input: 'note to self: check the Render logs tomorrow morning',
    tabs: [tab(tabKey.myNotes), tab(tabKey.decisions)],
    expect: [
      { desc: 'routes to my-notes, not decisions',
        check: (ops) => ops.some(o => o.tab === tabKey.myNotes) && !ops.some(o => o.tab === tabKey.decisions) }
    ]
  },

  // ── Ambiguous / irrelevant ──────────────────────────────────────────
  {
    name: 'irrelevant-input',
    input: "what's for lunch",
    tabs: [tab(tabKey.people, seededPeople), tab(tabKey.decisions)],
    expect: [
      { desc: 'returns empty ops',
        check: (ops) => ops.length === 0 }
    ]
  },
  {
    name: 'ambiguous-input',
    input: 'wrong',
    tabs: [tab(tabKey.people, seededPeople)],
    expect: [
      { desc: 'returns empty ops (no guesses)',
        check: (ops) => ops.length === 0 }
    ]
  }
]

// ── Runner ───────────────────────────────────────────────────────────────

async function callRouter(input, tabs) {
  const tabsBlock = buildTabsBlock(tabs)
  const user = buildRouterUserMessage(input, tabsBlock)

  const res = await fetch(ANTHROPIC_URL, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': process.env.ANTHROPIC_API_KEY,
      'anthropic-version': '2023-06-01'
    },
    body: JSON.stringify({
      model: MODEL, max_tokens: 2000,
      system: ROUTER_SYSTEM_PROMPT,
      messages: [{ role: 'user', content: user }]
    })
  })
  if (!res.ok) throw new Error(`Anthropic ${res.status}: ${await res.text()}`)
  const data = await res.json()
  const raw = data.content?.[0]?.text?.trim() || '[]'
  return { ops: extractJsonArray(raw), raw }
}

// Apply ops against seeded tab state and return a map {tabKey: data}.
function applyAll(seededTabs, ops) {
  const byKey = Object.fromEntries(seededTabs.map(t => [t.key, t.structured]))
  const errors = []
  for (const o of ops || []) {
    if (!byKey[o.tab]) { errors.push({ op: o.op, msg: `unknown tab ${o.tab}` }); continue }
    const filename = o.tab.split(':')[1]
    try {
      byKey[o.tab] = applyOp(filename, byKey[o.tab], o.op, o.args || {})
    } catch (err) {
      errors.push({ op: o.op, msg: err.message })
    }
  }
  return { data: byKey, errors }
}

function globMatch(pattern, name) {
  if (!pattern) return true
  const re = new RegExp('^' + pattern.replace(/[.+?^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*') + '$')
  return re.test(name)
}

const argv = process.argv.slice(2)
const verbose = argv.includes('--verbose')
const filterArg = argv.find(a => a.startsWith('--case='))
const filter = filterArg ? filterArg.split('=')[1] : null

async function run() {
  const results = []
  for (const c of cases) {
    if (!globMatch(filter, c.name)) continue
    process.stdout.write(`▶ ${c.name} ... `)
    const t0 = Date.now()
    try {
      const { ops, raw } = await callRouter(c.input, c.tabs)
      const { data: finalData, errors: applyErrors } = applyAll(c.tabs, ops)
      const ms = Date.now() - t0
      const checks = c.expect.map(e => {
        try { return { desc: e.desc, ok: !!e.check(ops, finalData) } }
        catch (err) { return { desc: e.desc, ok: false, err: err.message } }
      })
      const pass = checks.every(x => x.ok)
      results.push({ name: c.name, pass, checks, ms, ops, applyErrors, raw, input: c.input, finalData })
      console.log(pass ? `✓ (${ms}ms)` : `✗ (${ms}ms)`)
    } catch (err) {
      results.push({ name: c.name, pass: false, checks: [], ms: Date.now() - t0, error: err.message, input: c.input })
      console.log(`✗ ERROR: ${err.message}`)
    }
  }

  console.log('\n' + '━'.repeat(72))
  console.log('RESULTS')
  console.log('━'.repeat(72))
  for (const r of results) {
    console.log(`\n${r.pass ? '✓' : '✗'} ${r.name}  [${r.ms}ms]`)
    console.log(`  input: "${r.input}"`)
    if (r.error) { console.log(`  ERROR: ${r.error}`); continue }
    if (r.applyErrors?.length) console.log(`  apply errors: ${r.applyErrors.map(e => e.op + '(' + e.msg + ')').join(', ')}`)
    for (const ch of r.checks) {
      console.log(`  ${ch.ok ? '✓' : '✗'} ${ch.desc}${ch.err ? ' (threw: ' + ch.err + ')' : ''}`)
    }
    if (!r.pass || verbose) {
      console.log(`  ops: ${r.ops?.length ?? 0}`)
      if (verbose) {
        console.log('  ops JSON: ' + JSON.stringify(r.ops, null, 2).replace(/\n/g, '\n    '))
        console.log('  raw: ' + (r.raw?.substring(0, 300) || ''))
      }
    }
  }

  const passed = results.filter(r => r.pass).length
  const total = results.length
  console.log('\n' + '━'.repeat(72))
  console.log(`SUMMARY: ${passed}/${total} passed`)
  console.log('━'.repeat(72))

  const failBuckets = {}
  for (const r of results) {
    for (const ch of r.checks || []) if (!ch.ok) failBuckets[ch.desc] = (failBuckets[ch.desc] || 0) + 1
  }
  if (Object.keys(failBuckets).length) {
    console.log('\nFailure buckets:')
    for (const [desc, n] of Object.entries(failBuckets).sort((a, b) => b[1] - a[1])) {
      console.log(`  ${n}×  ${desc}`)
    }
  }
  process.exit(passed === total ? 0 : 1)
}

run().catch(err => { console.error(err); process.exit(1) })
