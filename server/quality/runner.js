// Delma Quality Lab — runs all five observability layers and writes
// findings to quality_* tables. Triggered every 6 hours via setInterval
// in server/index.js. Idempotent — re-running just adds another row of
// observations.
//
// Each layer is independent. A failure in one doesn't stop the others.

import { supabase as sb } from '../lib/supabase.js'
import { ROUTER_SYSTEM_PROMPT, buildTabsBlock, buildRouterUserMessage } from '../../src/router-prompt.js'
import { extractJsonArray } from '../../src/extract-json-array.js'
import { applyOp, emptyData } from '../../src/tab-ops.js'
import { runReplay } from './replay.js'
import { runAllNarratives } from './narratives.js'
import { runTimeliness } from './timeliness.js'
import { ANTHROPIC_URL, anthropicHeaders } from '../lib/llm.js'

const HAIKU = 'claude-haiku-4-5'
const SONNET = 'claude-sonnet-4-5'

async function callAnthropic(model, system, user, max_tokens = 2000) {
  const res = await fetch(ANTHROPIC_URL, {
    method: 'POST',
    headers: anthropicHeaders('quality-layer'),
    body: JSON.stringify({ model, max_tokens, system, messages: [{ role: 'user', content: user }] })
  })
  if (!res.ok) throw new Error(`Anthropic ${res.status}: ${await res.text()}`)
  const data = await res.json()
  return data.content?.[0]?.text || ''
}

async function recordStatus(layer, ms, error) {
  await sb.from('quality_runner_status').upsert({
    layer, last_run_at: new Date().toISOString(),
    last_duration_ms: ms, last_error: error || null
  })
}

// ── Layer 1: Regression evals ──────────────────────────────────────────────
// Re-implement the eval-router cases here so the server can run them on a
// schedule without shelling out to scripts/. Same canonical cases.

import { CASES as EVAL_CASES, runCases } from './eval-cases.js'

async function layer1RegressionEvals({ runId = null } = {}) {
  const t0 = Date.now()
  console.log('[quality] L1 — regression evals starting...')
  try {
    const results = await runCases(EVAL_CASES)
    const rows = results.map(r => ({
      case_name: r.name, pass: r.pass, ms: r.ms,
      ops_emitted: r.ops, raw_response: r.raw,
      failure_reasons: r.checks.filter(c => !c.ok).map(c => c.desc),
      model: HAIKU,
      run_id: runId
    }))
    if (rows.length) await sb.from('quality_eval_runs').insert(rows)
    const passed = results.filter(r => r.pass).length
    console.log(`[quality] L1 done — ${passed}/${results.length} passed in ${Date.now() - t0}ms`)
    await recordStatus('layer1_regression', Date.now() - t0, null)
  } catch (err) {
    console.error('[quality] L1 failed:', err.message)
    await recordStatus('layer1_regression', Date.now() - t0, err.message)
  }
}

// ── Layer 2: Production critique ──────────────────────────────────────────
// Pull recent api_op_logs + mcp_call_logs and have Sonnet grade each call.

const CRITIC_SYS = `You are a Delma quality critic. You evaluate whether a single typed-op call was appropriate.

Score 1-5:
  5 = clean, exactly the right op
  4 = correct but minor (could have been more specific, e.g. used add_decision instead of supersede_decision)
  3 = right tab but suboptimal op choice
  2 = suspicious — possibly lost info or wrong scope
  1 = wrong — the op caused real damage

Return ONLY JSON: {"score": <int>, "severity": "clean"|"minor"|"suspicious"|"wrong", "finding": "<one sentence>", "suggestion": "<one sentence or null>"}.

severity mapping: 5→clean, 4→minor, 3→minor, 2→suspicious, 1→wrong.

No prose outside the JSON.`

async function layer2ProductionCritique({ runId = null } = {}) {
  const t0 = Date.now()
  console.log('[quality] L2 — production critique starting...')
  try {
    // Pull api_op_logs from last 6 hours that we haven't critiqued yet.
    // (Lightweight check: skip if any observation already references this id.)
    const since = new Date(Date.now() - 6 * 60 * 60 * 1000).toISOString()
    const { data: logs } = await sb.from('api_op_logs')
      .select('*').gte('created_at', since).limit(50)
    if (!logs?.length) {
      console.log('[quality] L2 — no logs to critique')
      return await recordStatus('layer2_critique', Date.now() - t0, null)
    }

    // Skip ones already critiqued
    const { data: existing } = await sb.from('quality_observations')
      .select('source_id').eq('source', 'api_op').in('source_id', logs.map(l => String(l.id)))
    const seen = new Set((existing || []).map(o => o.source_id))
    const fresh = logs.filter(l => !seen.has(String(l.id)))
    console.log(`[quality] L2 — ${fresh.length} fresh ops (of ${logs.length} in window)`)

    let observed = 0
    for (const log of fresh.slice(0, 20)) {     // cap per-run cost
      const userMsg = `Tab: ${log.tab_key}\nOps applied: ${JSON.stringify(log.ops, null, 2)}\nApplied count: ${log.applied_count} | Errors: ${log.error_count} | Duration: ${log.duration_ms}ms\nSuccess: ${log.success}${log.error ? ' | Error: ' + log.error : ''}\n\nGrade this typed-op call.`
      try {
        const raw = await callAnthropic(SONNET, CRITIC_SYS, userMsg, 500)
        const cleaned = raw.replace(/^```(?:json)?\n?/, '').replace(/\n?```$/, '')
        const j = JSON.parse(cleaned)
        await sb.from('quality_observations').insert({
          source: 'api_op', source_id: String(log.id),
          severity: j.severity || 'clean', score: j.score, finding: j.finding,
          suggestion: j.suggestion || null,
          context: { tab_key: log.tab_key, ops: log.ops, success: log.success, error: log.error }
        })
        observed++
      } catch (err) {
        console.warn('[quality] L2 critic failed for log', log.id, ':', err.message)
      }
    }
    console.log(`[quality] L2 done — observed ${observed} calls in ${Date.now() - t0}ms`)
    await recordStatus('layer2_critique', Date.now() - t0, null)
  } catch (err) {
    console.error('[quality] L2 failed:', err.message)
    await recordStatus('layer2_critique', Date.now() - t0, err.message)
  }
}

// ── Layer 3: SQL data hygiene ─────────────────────────────────────────────
// Pure SQL/JS — no LLM. Quick sanity checks on structured tab content.

async function layer3StateChecks({ runId = null } = {}) {
  const t0 = Date.now()
  console.log('[quality] L3 — state hygiene starting...')
  try {
    const findings = []

    // Skip QA projects — their orphans/missing data are intentional test artifacts
    const { data: qaOrg } = await sb.from('organizations').select('id').eq('name', 'Delma QA Simulation Org').maybeSingle()
    const qaOrgId = qaOrg?.id
    const { data: qaWs } = qaOrgId ? await sb.from('projects').select('id').eq('org_id', qaOrgId) : { data: [] }
    const qaWsIds = new Set((qaWs || []).map(w => w.id))

    // Decisions without owner, older than 7 days
    const sevenDaysAgo = new Date(Date.now() - 7 * 86400 * 1000).toISOString()
    const { data: decRows } = await sb.from('memory_notes')
      .select('id, project_id, structured, updated_at')
      .eq('filename', 'decisions.md').not('structured', 'is', null).lt('updated_at', sevenDaysAgo)
    for (const r of decRows || []) {
      if (qaWsIds.has(r.project_id)) continue
      const unowned = (r.structured?.decisions || []).filter(d => !d.owner)
      if (unowned.length) {
        findings.push({
          project_id: r.project_id, check_name: 'unowned_decision', severity: 'warn',
          detail: `${unowned.length} decision(s) without owner, untouched for >7 days`,
          ref: { row_id: r.id, decisions: unowned.slice(0, 3).map(d => d.text) }
        })
      }
    }

    // Overdue actions
    const { data: actRows } = await sb.from('memory_notes')
      .select('id, project_id, structured').eq('filename', 'decisions.md').not('structured', 'is', null)
    for (const r of actRows || []) {
      if (qaWsIds.has(r.project_id)) continue
      const overdue = (r.structured?.actions || []).filter(a => !a.done && a.due)
      if (overdue.length) {
        findings.push({
          project_id: r.project_id, check_name: 'overdue_action', severity: 'info',
          detail: `${overdue.length} action(s) past due and not done`,
          ref: { row_id: r.id, examples: overdue.slice(0, 3).map(a => `${a.text} (due ${a.due})`) }
        })
      }
    }

    // Architecture orphans
    const { data: archRows } = await sb.from('diagram_views')
      .select('id, project_id, structured').eq('view_key', 'architecture').not('structured', 'is', null)
    for (const r of archRows || []) {
      if (qaWsIds.has(r.project_id)) continue
      const nodes = r.structured?.nodes || []
      const edges = r.structured?.edges || []
      const used = new Set([...edges.map(e => e.from), ...edges.map(e => e.to)])
      const orphans = nodes.filter(n => !used.has(n.id))
      if (orphans.length > 1) {       // 1 lone node is OK; >1 suggests forgotten work
        findings.push({
          project_id: r.project_id, check_name: 'orphan_arch_node', severity: 'info',
          detail: `${orphans.length} architecture node(s) with no edges (likely incomplete)`,
          ref: { row_id: r.id, ids: orphans.slice(0, 5).map(n => n.id) }
        })
      }
    }

    // People without role
    const { data: peopleRows } = await sb.from('org_memory_notes')
      .select('id, org_id, structured').eq('filename', 'people.md').not('structured', 'is', null)
    for (const r of peopleRows || []) {
      if (qaOrgId && r.org_id === qaOrgId) continue
      const roleless = (r.structured?.people || []).filter(p => !p.role && p.kind === 'person')
      if (roleless.length) {
        findings.push({
          org_id: r.org_id, check_name: 'unowned_role', severity: 'info',
          detail: `${roleless.length} person(s) without a role assigned`,
          ref: { row_id: r.id, names: roleless.slice(0, 5).map(p => p.name) }
        })
      }
    }

    if (findings.length) {
      const tagged = findings.map(f => ({ ...f, run_id: runId }))
      await sb.from('quality_state_checks').insert(tagged)
    }
    console.log(`[quality] L3 done — ${findings.length} findings in ${Date.now() - t0}ms`)
    await recordStatus('layer3_state', Date.now() - t0, null)
  } catch (err) {
    console.error('[quality] L3 failed:', err.message)
    await recordStatus('layer3_state', Date.now() - t0, err.message)
  }
}

// ── Layer 4: Router signal mining ─────────────────────────────────────────
// Look at recent router calls. Find: empty-ops responses, fan-outs, repeat
// inputs. Have Sonnet propose what's missing.

async function layer4RouterSignals({ runId = null } = {}) {
  const t0 = Date.now()
  console.log('[quality] L4 — router signal mining starting...')
  try {
    const since = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString()
    const { data: calls } = await sb.from('quality_router_calls')
      .select('input, ops').gte('created_at', since).limit(500)
    if (!calls?.length) {
      console.log('[quality] L4 — no router calls in window')
      return await recordStatus('layer4_signals', Date.now() - t0, null)
    }

    const empty = calls.filter(c => !c.ops || c.ops.length === 0).map(c => c.input)
    const fanOut = calls.filter(c => {
      const tabs = new Set((c.ops || []).map(o => o.tab))
      return tabs.size >= 3
    }).map(c => c.input)

    if (empty.length >= 5) {
      // Cluster the empties via Sonnet — what pattern is being missed?
      const sample = empty.slice(0, 25).map((e, i) => `${i + 1}. ${e}`).join('\n')
      const prompt = `Below are user inputs that the Delma router returned [] (no-op) for. Some are genuinely irrelevant (chitchat, questions). Others may indicate a missing feature (op or tab). Identify ONE pattern that suggests a feature gap, if any.

Inputs:
${sample}

Return JSON: {"pattern": "<short label>", "count": <how many of the inputs match>, "examples": [<up to 3 examples>], "suggestion": "<one sentence — what op or tab might fill this gap, or null if it's all irrelevant>"}.

Return only the JSON.`
      try {
        const raw = await callAnthropic(SONNET, 'You are a product analyst spotting feature gaps from router behavior. Be honest if there is no real signal.', prompt, 500)
        const j = JSON.parse(raw.replace(/^```(?:json)?\n?/, '').replace(/\n?```$/, ''))
        if (j.pattern && j.count >= 2) {
          await sb.from('quality_signals').insert({
            pattern: j.pattern, count: j.count,
            examples: j.examples || [], suggestion: j.suggestion || null
          })
        }
      } catch (err) { console.warn('[quality] L4 cluster failed:', err.message) }
    }

    if (fanOut.length >= 3) {
      await sb.from('quality_signals').insert({
        pattern: 'high_fan_out', count: fanOut.length,
        examples: fanOut.slice(0, 3),
        suggestion: 'Inputs touching 3+ tabs are common — consider whether these are well-decomposed or hint at an aggregate op.'
      })
    }

    console.log(`[quality] L4 done — analyzed ${calls.length} calls (${empty.length} empty, ${fanOut.length} fan-out) in ${Date.now() - t0}ms`)
    await recordStatus('layer4_signals', Date.now() - t0, null)
  } catch (err) {
    console.error('[quality] L4 failed:', err.message)
    await recordStatus('layer4_signals', Date.now() - t0, err.message)
  }
}

// ── Layer 5: A/B prompt leaderboard ───────────────────────────────────────
// For now: re-runs the eval suite against a candidate model (Sonnet) so we
// have a comparison line vs production Haiku. Real prompt variants can be
// added by editing CANDIDATES.

const CANDIDATES = [
  { name: 'baseline_haiku', model: HAIKU, prompt: ROUTER_SYSTEM_PROMPT },
  { name: 'sonnet', model: SONNET, prompt: ROUTER_SYSTEM_PROMPT }
]

async function layer5Experiments({ runId = null } = {}) {
  const t0 = Date.now()
  console.log('[quality] L5 — A/B experiments starting...')
  try {
    let baselineRate = null
    for (const cand of CANDIDATES) {
      const results = await runCases(EVAL_CASES, { model: cand.model, system: cand.prompt })
      const passed = results.filter(r => r.pass).length
      const passRate = passed / results.length
      const medianMs = median(results.map(r => r.ms))
      if (cand.name === 'baseline_haiku') baselineRate = passRate
      await sb.from('quality_experiments').insert({
        name: cand.name,
        config: { model: cand.model, prompt_chars: cand.prompt.length },
        pass_rate: passRate, median_ms: medianMs, total_cases: results.length,
        vs_baseline_delta: baselineRate != null ? (passRate - baselineRate) : 0
      })
    }
    console.log(`[quality] L5 done in ${Date.now() - t0}ms`)
    await recordStatus('layer5_experiments', Date.now() - t0, null)
  } catch (err) {
    console.error('[quality] L5 failed:', err.message)
    await recordStatus('layer5_experiments', Date.now() - t0, err.message)
  }
}

function median(arr) {
  const sorted = arr.filter(x => x != null).sort((a, b) => a - b)
  return sorted.length ? sorted[Math.floor(sorted.length / 2)] : null
}

// ── Master entry ──────────────────────────────────────────────────────────

export async function runAllLayers({ skipExpensive = false, runId = null } = {}) {
  console.log('[quality] runner start, skipExpensive:', skipExpensive)
  const t0 = Date.now()
  await layer1RegressionEvals({ runId })
  await layer3StateChecks({ runId })              // cheap, always run
  await timelinessLayer({ runId })                // pure JS, free
  await layer4RouterSignals({ runId })
  if (!skipExpensive) {
    await layer2ProductionCritique({ runId })     // Sonnet $$
    await layer5Experiments({ runId })             // 2x eval suite $
  }
  console.log(`[quality] runner done in ${Date.now() - t0}ms`)
}

// Headline overnight job: replay yesterday's real ops if we have any,
// otherwise fall back to running the curated narrative library.
// Both write to quality_simulations / quality_observations.
export async function runOvernight(opts = {}) {
  console.log('[quality] overnight start')
  const t0 = Date.now()
  await recordStatus('overnight_start', 0, null)

  // Start a run row so every child log row groups under it. trigger differs
  // based on whether this came from the scheduler or a manual POST.
  const { startRun, completeRun } = await import('./run-tracker.js')
  const { NARRATIVES } = await import('./narratives.js')
  const run = await startRun({
    trigger: opts.trigger || 'overnight-manual',
    label: opts.label || 'overnight pipeline',
    narratives: NARRATIVES.map(n => n.id)
  })
  const runId = run.id

  try {
    const since = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString()
    const { count } = await sb.from('api_op_logs')
      .select('id', { count: 'exact', head: true }).gte('created_at', since)
    const realCount = count || 0
    if (realCount >= 5) {
      console.log(`[quality] overnight: ${realCount} real ops in last 24h — replay mode`)
      await runReplay({ hoursBack: 24, max: 30, runId })
    } else {
      console.log(`[quality] overnight: only ${realCount} real ops — narrative mode`)
      const { runAllNarratives } = await import('./narratives.js')
      await runAllNarratives({ runId })
    }
    await runAllLayers({ skipExpensive: true, runId })
    await recordStatus('overnight_done', Date.now() - t0, null)

    // Aggregate + generate the Sonnet "what to act on" summary.
    await completeRun(runId, { ranHygiene: true, ranSignals: true })
    console.log(`[quality] overnight done in ${Date.now() - t0}ms (run ${runId})`)
  } catch (err) {
    console.error('[quality] overnight failed:', err)
    await recordStatus('overnight_done', Date.now() - t0, err.message)
    try { await completeRun(runId, { ranHygiene: true, ranSignals: true }) } catch {}
  }
}

async function timelinessLayer({ runId = null } = {}) {
  const t0 = Date.now()
  try {
    const { findings } = await runTimeliness({ hoursBack: 24 })
    console.log(`[quality] timeliness — ${findings} findings in ${Date.now() - t0}ms`)
    await recordStatus('timeliness', Date.now() - t0, null)
  } catch (err) {
    console.error('[quality] timeliness failed:', err.message)
    await recordStatus('timeliness', Date.now() - t0, err.message)
  }
}

// Allow direct invocation: `node server/quality/runner.js`
if (import.meta.url === `file://${process.argv[1]}`) {
  const skip = process.argv.includes('--cheap')
  runAllLayers({ skipExpensive: skip }).then(() => process.exit(0))
}
