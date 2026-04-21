// Validation script for the two recent changes:
//   1. Dedup slimmed to exact-match only (src/tab-ops.js)
//   2. Prior conversation now includes tool-call evidence (server/chat/context.js)
//
// Run from repo root:   node scripts/test-dedup-and-history.js
//
// No network, no DB — pure function tests against imported modules. Exits
// non-zero on any failure so you can wire it into CI later if you want.

import { applyOps } from '../src/tab-ops.js'
import { priorConversationBlock } from '../server/chat/context.js'

let passed = 0
let failed = 0
const results = []

function assert(label, cond, detail = '') {
  if (cond) {
    passed++
    results.push({ label, ok: true })
  } else {
    failed++
    results.push({ label, ok: false, detail })
  }
}

// ── Part 1: dedup behavior ────────────────────────────────────────────────
console.log('\n=== Part 1: playbook dedup ===\n')

// Starting state: one existing rule.
const startingRules = {
  rules: [
    { id: 'r_existing', text: 'Asset Type 207 drag-and-drop emails stored as JSON: template → slots → blocks.', section: 'SFMC' }
  ]
}

// Test 1: the FOUR related-but-distinct SFMC 207 rules that the old semantic
// check was rejecting should now all land cleanly.
const distinctRules = [
  'Asset Type 207 safe-workflow: GET full asset JSON → save to disk → modify in memory → PUT entire asset back.',
  'NEVER PATCH assetType 207 emails — shallow merge wipes slot.content causing permanent corruption (errorcode 10005).',
  'Asset Type 207 corruption recovery: DELETE broken asset → POST saved JSON backup as new asset (same customerKey).',
  'PATCH is safe for freeform HTML emails (assetType 208), CloudPages, and non-template assets.'
]

let data = startingRules
for (const ruleText of distinctRules) {
  const result = applyOps('playbook.md', data, [{ op: 'add_playbook_rule', args: { text: ruleText, section: 'SFMC' } }])
  const applied = result.applied?.length > 0
  assert(
    `distinct rule lands: "${ruleText.slice(0, 50)}…"`,
    applied,
    applied ? '' : `errors: ${JSON.stringify(result.errors)}`
  )
  if (applied) data = result.data
}
assert('all 5 distinct rules in final data', data.rules.length === 5, `got ${data.rules.length}`)

// Test 2: exact duplicate (identical normalized text) must still be rejected.
const exactDupResult = applyOps('playbook.md', data, [{
  op: 'add_playbook_rule',
  args: { text: startingRules.rules[0].text, section: 'SFMC' }
}])
assert(
  'exact duplicate rejected',
  exactDupResult.errors.length > 0 && /near-duplicate/i.test(exactDupResult.errors[0].msg || ''),
  JSON.stringify(exactDupResult)
)

// Test 3: case/whitespace variation of an exact duplicate also rejected (normalizes away).
const whitespaceDupResult = applyOps('playbook.md', data, [{
  op: 'add_playbook_rule',
  args: { text: '  Asset Type 207 DRAG-and-drop emails stored as JSON: template → slots → blocks.  ', section: 'SFMC' }
}])
assert(
  'whitespace/case variant of exact duplicate rejected',
  whitespaceDupResult.errors.length > 0,
  JSON.stringify(whitespaceDupResult)
)

// ── Part 2: prior conversation formatting ─────────────────────────────────
console.log('\n=== Part 2: prior conversation formatting ===\n')

// Build a fake conversation where the assistant called two tools, tool
// results came back, then the user asked a follow-up. Exactly the scenario
// that caused Claude to doubt itself before.
const fakeMessages = [
  { role: 'user', content: 'Add these SFMC rules to the playbook.' },
  {
    role: 'assistant',
    content: 'Adding them now.',
    tool_calls: [
      { id: 'toolu_1', name: 'mcp__delma__delma_add_playbook_rule', input: { section: 'SFMC', text: 'NEVER PATCH 207.' } },
      { id: 'toolu_2', name: 'mcp__delma__delma_add_playbook_rule', input: { section: 'SFMC', text: 'Safe workflow: GET → modify → PUT.' } }
    ]
  },
  {
    role: 'tool',
    content: JSON.stringify([
      { tool_use_id: 'toolu_1', output: '{"ok":true,"applied":[{"op":"add_playbook_rule"}]}' },
      { tool_use_id: 'toolu_2', output: '{"ok":true,"applied":[{"op":"add_playbook_rule"}]}' }
    ])
  },
  { role: 'assistant', content: '✅ All rules added.' },
  { role: 'user', content: 'Did that actually work?' }
]

const block = priorConversationBlock(fakeMessages)

assert('prior block is non-empty', block.length > 0, `got ${block.length} chars`)
assert('user message appears',
  /\*\*user:\*\*\s+Add these SFMC rules/.test(block),
  block)
assert('assistant prose appears',
  /\*\*assistant:\*\*\s+Adding them now/.test(block),
  block)
assert('tool_use with name and input appears',
  /→ called `mcp__delma__delma_add_playbook_rule`/.test(block) && /NEVER PATCH 207/.test(block),
  block)
assert('tool_result line appears',
  /\*\*tool_result:\*\*/.test(block) && /"ok":true/.test(block),
  block)
assert('second assistant message (summary) appears',
  /All rules added/.test(block),
  block)
assert('follow-up user question appears',
  /Did that actually work\?/.test(block),
  block)

// ── Summary ────────────────────────────────────────────────────────────────
console.log('\n=== Results ===\n')
for (const r of results) {
  const icon = r.ok ? '✓' : '✗'
  const line = `${icon}  ${r.label}`
  console.log(r.ok ? line : `${line}\n     detail: ${r.detail}`)
}
console.log(`\n${passed} passed, ${failed} failed\n`)

if (failed > 0) process.exit(1)
