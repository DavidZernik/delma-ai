// Fast smoke-test runner for waking-hour iteration.
//
//   npm run smoke                  → evals + 1 default narrative (~40s)
//   npm run smoke -- --medium      → evals + 3 high-signal narratives (~3 min)
//   npm run smoke -- architecture-heavy  → evals + one specific narrative
//   npm run smoke -- --full        → evals + ALL 12 narratives locally (~12 min)
//   npm run smoke -- --evals       → regression evals only (~7s)
//   npm run smoke -- --no-evals a b → multiple specific narratives, skip evals
//
// For the full overnight pipeline (narratives + all supporting layers), use
// `npm run overnight` — that fires the prod server and returns immediately.
//
// All runs write to prod Supabase, so results show up on /logs. Per-narrative
// sim orgs are auto-cleaned after 3 days.

// Explicitly override shell env so stale empty values (common when running
// from a terminal that had the key unset earlier) don't shadow the .env file.
import { config } from 'dotenv'
config({ override: true })

import { runNarrative, NARRATIVES } from '../server/quality/narratives.js'
import { CASES, runCases } from '../server/quality/eval-cases.js'
import { startRun, completeRun } from '../server/quality/run-tracker.js'
import { createClient } from '@supabase/supabase-js'

const sb = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY)

const DEFAULT_NARRATIVES = ['sf-admin-config-only']  // fast + high-signal after today's fixes

// Three narratives chosen to cover the highest-signal failure modes: SFMC
// classification traps, compound-state dedup, and cross-BU trap. If these
// pass, the fix probably holds; if any regresses, it's worth investigating
// before firing the full overnight.
const MEDIUM_NARRATIVES = ['sf-admin-config-only', 'architecture-heavy', 'sfmc-cross-bu-trap']

function pickArgs(argv) {
  const args = argv.slice(2)
  const flags = new Set(args.filter(a => a.startsWith('--')))
  const positional = args.filter(a => !a.startsWith('--'))
  return {
    full: flags.has('--full'),
    medium: flags.has('--medium'),
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
  const preset = args.medium ? MEDIUM_NARRATIVES : (requested.length ? requested : DEFAULT_NARRATIVES)
  const byId = new Map(NARRATIVES.map(n => [n.id, n]))
  return preset.map(id => {
    const n = byId.get(id)
    if (!n) throw new Error(`unknown narrative: "${id}". Known: ${NARRATIVES.map(n => n.id).join(', ')}`)
    return n
  })
}

async function main() {
  const args = pickArgs(process.argv)
  const evalsOnly = args.evalsOnly
  const runEvals = !args.noEvals
  const narratives = evalsOnly ? [] : selectNarratives(args)

  const started = Date.now()
  const trigger = args.full ? 'smoke-full' : args.medium ? 'smoke-medium' : evalsOnly ? 'smoke-evals' : 'smoke'
  const label = `${trigger}: ${narratives.map(n => n.id).join(', ') || 'evals only'}`

  // Create a quality_runs row so all rows from this run group under one id.
  const run = await startRun({
    trigger,
    label,
    narratives: narratives.map(n => n.id)
  })

  console.log('─'.repeat(70))
  console.log(`SMOKE — ${narratives.length} narrative${narratives.length !== 1 ? 's' : ''}${runEvals ? ' + regression evals' : ''}`)
  if (narratives.length) console.log('  ' + narratives.map(n => n.id).join(', '))
  console.log(`  run id: ${run.id}`)
  console.log('─'.repeat(70))

  // Evals first (fast, no external state changes)
  if (runEvals) {
    console.log('\n▶ Regression evals...')
    const evalStart = Date.now()
    const evalResults = await runCases(CASES)
    const passed = evalResults.filter(r => r.pass).length
    const total = evalResults.length
    const evalMs = Date.now() - evalStart
    console.log(`  ${passed}/${total} passed (${evalMs}ms)`)
    for (const r of evalResults) {
      if (!r.pass) {
        const failedChecks = (r.checks || []).filter(c => !c.ok).map(c => c.desc)
        console.log(`    ✗ ${r.name}${r.error ? ` — ${r.error}` : ''}`)
        for (const d of failedChecks) console.log(`        · ${d}`)
      }
    }
    // Persist regression eval results against this run
    await sb.from('quality_eval_runs').insert({
      suite: 'canonical',
      passed,
      total,
      results: evalResults.map(r => ({ name: r.name, pass: r.pass, ms: r.ms, error: r.error || null })),
      duration_ms: evalMs,
      run_id: run.id
    })
  }

  // Narratives
  const results = []
  for (const n of narratives) {
    const t0 = Date.now()
    try {
      const r = await runNarrative(n, { runId: run.id })
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

  // Finalize the run — compute aggregates + generate the Sonnet summary.
  console.log('\n▶ Generating summary...')
  const { summary } = await completeRun(run.id)
  if (summary) {
    console.log('\nSummary:')
    console.log(summary.split('\n').map(l => '  ' + l).join('\n'))
  }

  if (results.length || runEvals) {
    console.log(`\nRun detail: https://delma-ai.onrender.com/logs/run/${run.id}`)
    console.log(`All runs:   https://delma-ai.onrender.com/logs`)
  }
  process.exit(results.some(r => r.error) ? 1 : 0)
}

main().catch(err => { console.error(err); process.exit(1) })
