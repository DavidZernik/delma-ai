// Groups a batch of quality-lab activity into a single "run" row so the
// /logs page can render one clickable card per run instead of a wall of
// loose sims and findings. Used by both smoke.js (local CLI) and the prod
// /quality/run-overnight endpoint.
//
// Usage:
//   const run = await startRun({ trigger: 'smoke-medium', label, narratives: [...] })
//   // ... run narratives and other layers, tagging rows with run.id ...
//   await completeRun(run.id)   // computes aggregates + generates summary

import { createClient } from '@supabase/supabase-js'
import { ANTHROPIC_URL, anthropicHeaders } from '../lib/llm.js'

const sb = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY)
const SONNET = 'claude-sonnet-4-5'

export async function startRun({ trigger, label, narratives = [] }) {
  const { data, error } = await sb
    .from('quality_runs')
    .insert({
      trigger,
      label: label || trigger,
      narratives_run: narratives,
      num_narratives: narratives.length,
      status: 'running'
    })
    .select()
    .single()
  if (error) throw new Error(`startRun failed: ${error.message}`)
  return data
}

// Compute aggregates + write the Sonnet "what to act on" summary. Called at
// the end of every run, from both smoke and overnight paths. Idempotent —
// safe to call twice.
export async function completeRun(runId, opts = {}) {
  const { data: sims } = await sb
    .from('quality_simulations')
    .select('id, overall_score, transcript, critique')
    .eq('run_id', runId)
  const scored = (sims || []).filter(s => typeof s.overall_score === 'number')

  const { data: cands } = await sb
    .from('quality_candidate_evals')
    .select('id')
    .eq('run_id', runId)

  const { data: evalRows } = await sb
    .from('quality_eval_runs')
    .select('results')
    .eq('run_id', runId)
    .order('ran_at', { ascending: false })
    .limit(1)
  const latestEvalResults = evalRows?.[0]?.results || []
  const numRegressionFails = latestEvalResults.filter(r => !r.pass).length

  const { data: stateWarnRows } = await sb
    .from('quality_state_checks')
    .select('id')
    .eq('run_id', runId)
    .eq('severity', 'warn')

  const scores = scored.map(s => s.overall_score)
  const overall = scores.length ? (scores.reduce((a, b) => a + b, 0) / scores.length) : null

  const aggregates = {
    num_complete: scored.length,
    overall_score: overall !== null ? Math.round(overall * 100) / 100 : null,
    min_score: scores.length ? Math.min(...scores) : null,
    max_score: scores.length ? Math.max(...scores) : null,
    num_candidates: cands?.length || 0,
    num_regression_fails: numRegressionFails,
    num_state_warnings: stateWarnRows?.length || 0,
    ran_regression: !!latestEvalResults.length,
    ran_hygiene: opts.ranHygiene ?? false,
    ran_signals: opts.ranSignals ?? false
  }

  // Generate the plain-English "what to act on" summary. If Sonnet fails,
  // fall back to a mechanical summary so the run still completes.
  let summary = null
  try {
    summary = await generateRunSummary(scored, latestEvalResults, aggregates)
  } catch (err) {
    console.warn('[run-tracker] summary generation failed, using fallback:', err.message)
    summary = mechanicalSummary(scored, aggregates)
  }

  const { error } = await sb
    .from('quality_runs')
    .update({
      ...aggregates,
      summary,
      ended_at: new Date().toISOString(),
      status: 'complete'
    })
    .eq('id', runId)
  if (error) console.warn('[run-tracker] completeRun update failed:', error.message)

  return { summary, aggregates }
}

async function generateRunSummary(sims, evalResults, aggregates) {
  if (!sims.length && !evalResults.length) {
    return 'Empty run — no narratives or regression evals completed.'
  }

  // Evals-only run — no narratives to grade. Report the eval state
  // directly without invoking Sonnet (cheap + deterministic).
  if (!sims.length && evalResults.length) {
    const passed = evalResults.filter(r => r.pass).length
    const failed = evalResults.filter(r => !r.pass)
    if (!failed.length) {
      return `All ${passed}/${evalResults.length} regression evals passed. Nothing to act on.`
    }
    return `${passed}/${evalResults.length} regression evals passed.\n\n**${failed.length} failing:**\n${
      failed.map(f => `- \`${f.name}\`${f.error ? ` — ${f.error}` : ''}`).join('\n')
    }`
  }

  const narrativeSummaries = sims.map(s => {
    const narrId = s.transcript?.narrative_id || 'unknown'
    const wrong = (s.critique?.wrong || []).slice(0, 3)
    const missed = (s.critique?.missed || []).slice(0, 3)
    return `### ${narrId} — ${s.overall_score}/5
Wrong: ${wrong.length ? wrong.join(' | ') : '(none)'}
Missed: ${missed.length ? missed.join(' | ') : '(none)'}`
  }).join('\n\n')

  const evalSummary = evalResults.length
    ? `Regression evals: ${evalResults.filter(r => r.pass).length}/${evalResults.length} passed. ${
        evalResults.filter(r => !r.pass).map(r => r.name).join(', ') || 'all green'
      }.`
    : 'Regression evals: not run this time.'

  const prompt = `You are summarizing a Delma Quality Lab run for a PM who just fired it and wants to know — in plain English — what to act on.

Run aggregates:
- ${aggregates.num_complete} narratives scored, average ${aggregates.overall_score}/5 (min ${aggregates.min_score}, max ${aggregates.max_score})
- ${aggregates.num_candidates} candidate eval findings filed
- ${aggregates.num_regression_fails} regression eval(s) failed

${evalSummary}

Per-narrative findings:
${narrativeSummaries}

Write the summary as:
1. ONE headline sentence — is this run good, okay, or concerning at a glance?
2. 2–4 short bullets on specific things to act on. Prioritize patterns that appear across multiple narratives over one-off issues. Be concrete — name the narrative or op or handler if useful.
3. If something notably worked, end with one "what held up" bullet.

Be human and concise. No jargon. No bullet inflation. If nothing is urgent, say so directly — don't manufacture issues.

Return plain markdown (no code fences, no preamble like "Summary:"). Start with the headline, then the bullets.`

  const res = await fetch(ANTHROPIC_URL, {
    method: 'POST',
    headers: anthropicHeaders('run-summary'),
    body: JSON.stringify({
      model: SONNET,
      max_tokens: 600,
      system: 'You produce concise, plain-English summaries of test-run results for a product owner. Be honest, specific, and un-fluffy.',
      messages: [{ role: 'user', content: prompt }]
    })
  })
  if (!res.ok) throw new Error(`Sonnet ${res.status}: ${(await res.text()).slice(0, 200)}`)
  const data = await res.json()
  return (data.content?.[0]?.text || '').trim()
}

function mechanicalSummary(sims, agg) {
  if (!sims.length) return `Run completed: no narratives scored. ${agg.num_regression_fails} regression fail(s).`
  const low = sims.filter(s => s.overall_score <= 2).length
  return `Average ${agg.overall_score}/5 across ${agg.num_complete} narratives. ${low} scored ≤ 2/5. ${agg.num_candidates} findings filed. ${agg.num_regression_fails} regression fail(s).`
}
