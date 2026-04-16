// Fast smoke-test runner for waking-hour iteration.
//
//   npm run smoke                  → runs 6 regression evals + 1 default narrative (~90s)
//   npm run smoke -- architecture-heavy  → runs one specific narrative + evals
//   npm run smoke -- --full        → runs ALL 12 narratives + evals (~12 min — same as overnight)
//   npm run smoke -- --evals       → regression evals only (~10s)
//   npm run smoke -- --narratives-only foo,bar → skip evals, run just those narratives
//
// Writes to the live Supabase (per-narrative sim orgs, auto-cleaned).
// Does NOT require a local server — hits Anthropic API + Supabase directly.

// Explicitly override shell env so stale empty values (common when running
// from a terminal that had the key unset earlier) don't shadow the .env file.
import { config } from 'dotenv'
config({ override: true })

import { runNarrative, NARRATIVES } from '../server/quality/narratives.js'
import { CASES, runCases } from '../server/quality/eval-cases.js'

const DEFAULT_NARRATIVES = ['sf-admin-config-only']  // fast + high-signal after today's fixes

function pickArgs(argv) {
  const args = argv.slice(2)
  const flags = new Set(args.filter(a => a.startsWith('--')))
  const positional = args.filter(a => !a.startsWith('--'))
  return {
    full: flags.has('--full'),
    evalsOnly: flags.has('--evals'),
    narrativesOnlyArg: args.find(a => a.startsWith('--narratives-only=')),
    noEvals: flags.has('--no-evals'),
    requested: positional
  }
}

function selectNarratives(args) {
  if (args.full) return NARRATIVES
  const fromFlag = args.narrativesOnlyArg ? args.narrativesOnlyArg.split('=')[1].split(',') : []
  const requested = [...args.requested, ...fromFlag].filter(Boolean)
  if (!requested.length) return NARRATIVES.filter(n => DEFAULT_NARRATIVES.includes(n.id))
  const byId = new Map(NARRATIVES.map(n => [n.id, n]))
  const picked = requested.map(id => {
    const n = byId.get(id)
    if (!n) throw new Error(`unknown narrative: "${id}". Known: ${NARRATIVES.map(n => n.id).join(', ')}`)
    return n
  })
  return picked
}

async function main() {
  const args = pickArgs(process.argv)
  const evalsOnly = args.evalsOnly
  const runEvals = !args.noEvals
  const narratives = evalsOnly ? [] : selectNarratives(args)

  const started = Date.now()
  console.log('─'.repeat(70))
  console.log(`SMOKE — ${narratives.length} narrative${narratives.length !== 1 ? 's' : ''}${runEvals ? ' + regression evals' : ''}`)
  if (narratives.length) console.log('  ' + narratives.map(n => n.id).join(', '))
  console.log('─'.repeat(70))

  // Evals first (fast, no external state changes)
  if (runEvals) {
    console.log('\n▶ Regression evals...')
    const evalStart = Date.now()
    const results = await runCases(CASES)
    const passed = results.filter(r => r.pass).length
    const total = results.length
    const evalMs = Date.now() - evalStart
    console.log(`  ${passed}/${total} passed (${evalMs}ms)`)
    for (const r of results) {
      if (!r.pass) {
        const failedChecks = (r.checks || []).filter(c => !c.ok).map(c => c.desc)
        console.log(`    ✗ ${r.name}${r.error ? ` — ${r.error}` : ''}`)
        for (const d of failedChecks) console.log(`        · ${d}`)
      }
    }
  }

  // Narratives
  const results = []
  for (const n of narratives) {
    const t0 = Date.now()
    try {
      const r = await runNarrative(n)
      results.push({ id: n.id, score: r.score, ms: Date.now() - t0, candidates: r.candidates })
    } catch (err) {
      results.push({ id: n.id, error: err.message, ms: Date.now() - t0 })
    }
  }

  const totalMs = Date.now() - started
  console.log('\n' + '─'.repeat(70))
  if (results.length) {
    console.log('NARRATIVE RESULTS:')
    for (const r of results) {
      if (r.error) console.log(`  ✗ ${r.id.padEnd(32)} ERROR: ${r.error}`)
      else         console.log(`  ${r.score}/5  ${r.id.padEnd(32)} ${Math.round(r.ms / 1000)}s  (${r.candidates} candidate evals filed)`)
    }
    const scored = results.filter(r => !r.error)
    if (scored.length > 1) {
      const avg = scored.reduce((a, b) => a + (b.score || 0), 0) / scored.length
      console.log(`  AVG: ${avg.toFixed(2)} / 5`)
    }
  }
  console.log('─'.repeat(70))
  console.log(`TOTAL: ${(totalMs / 1000).toFixed(1)}s`)
  process.exit(results.some(r => r.error) ? 1 : 0)
}

main().catch(err => { console.error(err); process.exit(1) })
