// Renders the /logs HTML page. Public, no auth — internal observability.
// Pulls from all quality_* tables and stitches a single readable view.

import { supabase as sb } from '../lib/supabase.js'

const css = `
  body { font-family: -apple-system, system-ui, sans-serif; max-width: 1100px; margin: 0 auto; padding: 24px; background: #FBF8F2; color: #2B1F1F; }
  h1 { font-size: 24px; margin: 0 0 4px; }
  .subtitle { color: #6B5A5A; font-size: 13px; margin-bottom: 24px; }
  h2 { font-size: 16px; margin: 32px 0 8px; padding-bottom: 4px; border-bottom: 2px solid #7A1E1E; color: #7A1E1E; text-transform: uppercase; letter-spacing: 0.05em; }
  .summary { display: grid; grid-template-columns: repeat(auto-fit, minmax(180px, 1fr)); gap: 12px; margin: 16px 0; }
  .stat { background: #FFFFFF; border: 1px solid #E8D8D2; border-radius: 8px; padding: 14px; }
  .stat .num { font-size: 24px; font-weight: 600; color: #7A1E1E; }
  .stat .lab { font-size: 11px; text-transform: uppercase; letter-spacing: 0.05em; color: #6B5A5A; margin-top: 4px; }
  table { width: 100%; border-collapse: separate; border-spacing: 0 4px; font-size: 13px; }
  th { text-align: left; font-weight: 600; color: #6B5A5A; padding: 4px 8px; font-size: 11px; text-transform: uppercase; letter-spacing: 0.04em; }
  td { padding: 8px 10px; vertical-align: top; background: #FFFFFF; }
  tr td:first-child { border-top-left-radius: 6px; border-bottom-left-radius: 6px; }
  tr td:last-child { border-top-right-radius: 6px; border-bottom-right-radius: 6px; }
  .pass { color: #6B8E5C; }
  .fail { color: #B33; }
  .sev-clean { color: #6B8E5C; }
  .sev-minor { color: #C9A878; }
  .sev-suspicious { color: #C56F2B; }
  .sev-wrong { color: #B33; font-weight: 600; }
  .sev-info { color: #6B5A5A; }
  .sev-warn { color: #C56F2B; }
  pre { background: #F4F0EA; padding: 8px; border-radius: 4px; font-size: 11px; max-width: 600px; overflow-x: auto; margin: 0; }
  code { font-family: ui-monospace, monospace; font-size: 11px; background: #F4F0EA; padding: 1px 4px; border-radius: 3px; }
  .ts { color: #6B5A5A; font-size: 11px; white-space: nowrap; }
  .empty { color: #6B5A5A; font-style: italic; padding: 12px; }
  details summary { cursor: pointer; color: #7A1E1E; font-size: 12px; }
  .layer-status { display: flex; gap: 16px; flex-wrap: wrap; margin: 8px 0 24px; font-size: 12px; color: #6B5A5A; }
  .layer-status span { background: #FFFFFF; border: 1px solid #E8D8D2; padding: 4px 10px; border-radius: 4px; }
`

const esc = (s) => String(s ?? '').replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]))
const ago = (iso) => {
  if (!iso) return '—'
  const ms = Date.now() - new Date(iso).getTime()
  const m = Math.floor(ms / 60000)
  if (m < 60) return `${m}m ago`
  const h = Math.floor(m / 60)
  if (h < 24) return `${h}h ago`
  return `${Math.floor(h / 24)}d ago`
}

export async function renderLogsPage() {
  // Pull everything in parallel
  const [
    statusRes, simRes, evalRes, obsRes, stateRes, signalsRes, expRes, opsRes, routerRes
  ] = await Promise.all([
    sb.from('quality_runner_status').select('*'),
    sb.from('quality_simulations').select('*').order('ran_at', { ascending: false }).limit(7),
    sb.from('quality_eval_runs').select('*').order('run_at', { ascending: false }).limit(100),
    sb.from('quality_observations').select('*').order('observed_at', { ascending: false }).limit(50),
    sb.from('quality_state_checks').select('*').order('checked_at', { ascending: false }).limit(50),
    sb.from('quality_signals').select('*').order('found_at', { ascending: false }).limit(20),
    sb.from('quality_experiments').select('*').order('ran_at', { ascending: false }).limit(20),
    sb.from('api_op_logs').select('*').order('created_at', { ascending: false }).limit(30),
    sb.from('quality_router_calls').select('*').order('created_at', { ascending: false }).limit(30)
  ])
  const sims = simRes.data || []
  const status = statusRes.data || []
  const evals = evalRes.data || []
  const obs = obsRes.data || []
  const state = stateRes.data || []
  const signals = signalsRes.data || []
  const exps = expRes.data || []
  const ops = opsRes.data || []
  const routerCalls = routerRes.data || []

  // Aggregate latest eval run
  const latestRun = evals.length ? evals.reduce((acc, r) => (r.run_at > acc ? r.run_at : acc), evals[0].run_at) : null
  const latestRunRows = evals.filter(r => r.run_at === latestRun)
  const passed = latestRunRows.filter(r => r.pass).length
  const passRate = latestRunRows.length ? Math.round((passed / latestRunRows.length) * 100) : 0

  const obsCounts = { clean: 0, minor: 0, suspicious: 0, wrong: 0 }
  for (const o of obs) obsCounts[o.severity] = (obsCounts[o.severity] || 0) + 1

  // ── Build "Things to act on" — the most actionable distillation ────
  const actionItems = []
  // Failed eval cases (latest run)
  for (const r of latestRunRows.filter(r => !r.pass)) {
    actionItems.push({
      severity: 'wrong',
      what: `Eval case "${r.case_name}" failed`,
      why: r.failure_reasons?.join(' · ') || 'see eval row',
      where: 'Layer 1 (regression evals)'
    })
  }
  // Suspicious + wrong observations from production critique / replay
  for (const o of obs.filter(o => o.severity === 'wrong' || o.severity === 'suspicious')) {
    actionItems.push({
      severity: o.severity,
      what: o.finding,
      why: o.suggestion || '',
      where: `Layer 2 (${o.source}#${o.source_id || ''})`
    })
  }
  // State warnings
  for (const s of state.filter(s => s.severity === 'warn')) {
    actionItems.push({
      severity: 'warn',
      what: s.detail,
      why: s.check_name,
      where: 'Layer 3 (state hygiene)'
    })
  }
  // Latest sim findings
  for (const sim of sims.slice(0, 1)) {
    if (sim.critique?.missed?.length) {
      for (const m of sim.critique.missed) actionItems.push({
        severity: 'suspicious',
        what: `Sim missed: ${m}`,
        why: sim.transcript?.narrative_title || 'overnight simulation',
        where: 'Overnight (missed)'
      })
    }
    if (sim.critique?.wrong?.length) {
      for (const w of sim.critique.wrong) actionItems.push({
        severity: 'wrong',
        what: `Sim wrong: ${w}`,
        why: sim.transcript?.narrative_title || 'overnight simulation',
        where: 'Overnight (wrong)'
      })
    }
  }
  // Sort: wrong > suspicious > warn > info
  const sevRank = { wrong: 0, suspicious: 1, warn: 2, info: 3, minor: 4, clean: 5 }
  actionItems.sort((a, b) => (sevRank[a.severity] ?? 9) - (sevRank[b.severity] ?? 9))

  return `<!doctype html>
<html><head><meta charset="utf-8"><title>Delma — Logs</title><style>${css}</style></head><body>
<h1>Delma Quality Lab</h1>
<div class="subtitle">Public observability — overnight test (10pm–7am PT) + every-6h cheap checks. Last 24–72h.</div>

<h2>Things to act on (today)</h2>
${actionItems.length ? `<table><tr><th>Severity</th><th>What</th><th>Why / suggestion</th><th>Source</th></tr>
${actionItems.slice(0, 30).map(a => `<tr><td class="sev-${a.severity}">${esc(a.severity)}</td><td>${esc(a.what)}</td><td>${esc(a.why)}</td><td class="ts">${esc(a.where)}</td></tr>`).join('')}
</table>${actionItems.length > 30 ? `<div class="empty">+ ${actionItems.length - 30} more lower-priority items below.</div>` : ''}` : '<div class="empty">All clear. Nothing actionable in the last cycle.</div>'}

<div class="summary">
  <div class="stat"><div class="num">${passed}/${latestRunRows.length || 0}</div><div class="lab">Eval Pass Rate (${passRate}%)</div></div>
  <div class="stat"><div class="num">${ops.length}</div><div class="lab">Recent /api/op writes</div></div>
  <div class="stat"><div class="num">${routerCalls.length}</div><div class="lab">Recent router calls</div></div>
  <div class="stat"><div class="num">${obsCounts.suspicious + obsCounts.wrong}</div><div class="lab">Suspicious + wrong</div></div>
  <div class="stat"><div class="num">${state.length}</div><div class="lab">State warnings</div></div>
  <div class="stat"><div class="num">${signals.length}</div><div class="lab">Signal patterns</div></div>
</div>

<div class="layer-status">
  ${status.map(s => `<span><strong>${esc(s.layer)}</strong> · ${ago(s.last_run_at)} · ${s.last_duration_ms ?? '?'}ms${s.last_error ? ' · <span class="fail">' + esc(s.last_error) + '</span>' : ''}</span>`).join('') || '<span class="empty">no runs yet</span>'}
</div>

<h2>Overnight Simulation (the headline test)</h2>
${sims.length ? `<table><tr><th>When</th><th>Score</th><th>Summary</th><th>ms</th><th>Detail</th></tr>
${sims.map(s => `<tr><td class="ts">${ago(s.ran_at)}</td><td class="${(s.overall_score || 0) >= 4 ? 'pass' : 'fail'}"><strong>${s.overall_score || '—'}/5</strong></td><td>${esc(s.critique?.summary || '')}</td><td>${s.total_duration_ms ?? '—'}</td><td><details><summary>transcript + state</summary><pre>${esc(JSON.stringify({ scores: s.critique?.scores, missed: s.critique?.missed, wrong: s.critique?.wrong, praise: s.critique?.praise, ops: s.ops_applied?.length, turns: s.transcript?.length }, null, 2))}</pre></details></td></tr>`).join('')}
</table>` : '<div class="empty">No overnight runs yet. Trigger one with <code>POST /quality/run-sim</code> or wait for the 10pm-7am PT window.</div>'}

<h2>Layer 1 — Regression Evals (latest run)</h2>
${latestRunRows.length ? `<table><tr><th>Case</th><th>Result</th><th>ms</th><th>Failures</th></tr>
${latestRunRows.map(r => `<tr><td>${esc(r.case_name)}</td><td class="${r.pass ? 'pass' : 'fail'}">${r.pass ? '✓ pass' : '✗ fail'}</td><td>${r.ms}</td><td>${r.failure_reasons?.length ? esc(r.failure_reasons.join(' · ')) : '—'}</td></tr>`).join('')}
</table>` : '<div class="empty">No eval runs yet. Trigger one with <code>POST /quality/run</code> or wait for the next scheduled fire.</div>'}

<h2>Layer 2 — Production Critique (Sonnet on real ops)</h2>
${obs.length ? `<table><tr><th>When</th><th>Source</th><th>Severity</th><th>Score</th><th>Finding</th><th>Suggestion</th></tr>
${obs.map(o => `<tr><td class="ts">${ago(o.observed_at)}</td><td>${esc(o.source)}#${esc(o.source_id || '')}</td><td class="sev-${o.severity}">${esc(o.severity)}</td><td>${o.score ?? '—'}</td><td>${esc(o.finding)}</td><td>${esc(o.suggestion || '—')}</td></tr>`).join('')}
</table>` : '<div class="empty">No critiques yet — build up some real /api/op activity first, then wait for the next run.</div>'}

<h2>Layer 3 — State Hygiene</h2>
${state.length ? `<table><tr><th>When</th><th>Check</th><th>Severity</th><th>Detail</th><th>Ref</th></tr>
${state.map(s => `<tr><td class="ts">${ago(s.checked_at)}</td><td>${esc(s.check_name)}</td><td class="sev-${s.severity}">${esc(s.severity)}</td><td>${esc(s.detail)}</td><td><details><summary>show</summary><pre>${esc(JSON.stringify(s.ref, null, 2))}</pre></details></td></tr>`).join('')}
</table>` : '<div class="empty">No state warnings.</div>'}

<h2>Layer 4 — Router Signal Mining</h2>
${signals.length ? `<table><tr><th>When</th><th>Pattern</th><th>Count</th><th>Examples</th><th>Suggestion</th></tr>
${signals.map(s => `<tr><td class="ts">${ago(s.found_at)}</td><td><strong>${esc(s.pattern)}</strong></td><td>${s.count}</td><td>${(s.examples || []).slice(0, 3).map(e => '<code>' + esc(e.substring(0, 80)) + '</code>').join('<br>')}</td><td>${esc(s.suggestion || '—')}</td></tr>`).join('')}
</table>` : '<div class="empty">No signal patterns yet.</div>'}

<h2>Layer 5 — A/B Experiments</h2>
${exps.length ? `<table><tr><th>When</th><th>Variant</th><th>Pass Rate</th><th>Median ms</th><th>vs Baseline</th></tr>
${exps.map(e => `<tr><td class="ts">${ago(e.ran_at)}</td><td>${esc(e.name)}</td><td>${Math.round((e.pass_rate || 0) * 100)}%</td><td>${e.median_ms ?? '—'}</td><td>${e.vs_baseline_delta != null ? (e.vs_baseline_delta > 0 ? '+' : '') + Math.round(e.vs_baseline_delta * 100) + 'pp' : '—'}</td></tr>`).join('')}
</table>` : '<div class="empty">No experiments yet.</div>'}

<h2>Recent /api/op Writes</h2>
${ops.length ? `<table><tr><th>When</th><th>Tab</th><th>Ops</th><th>Status</th></tr>
${ops.map(o => `<tr><td class="ts">${ago(o.created_at)}</td><td><code>${esc(o.tab_key)}</code></td><td>${(o.ops || []).map(op => '<code>' + esc(op.op) + '</code>').join(' ')}</td><td class="${o.success ? 'pass' : 'fail'}">${o.success ? '✓' : '✗ ' + esc(o.error || '')}</td></tr>`).join('')}
</table>` : '<div class="empty">No /api/op writes yet.</div>'}

<h2>Recent Router Calls</h2>
${routerCalls.length ? `<table><tr><th>When</th><th>Input</th><th>Ops</th><th>ms</th></tr>
${routerCalls.map(c => `<tr><td class="ts">${ago(c.created_at)}</td><td>${esc(c.input.substring(0, 120))}</td><td>${(c.ops || []).map(op => '<code>' + esc(op.tab) + '/' + esc(op.op) + '</code>').join(' ')}${(!c.ops || !c.ops.length) ? '<span class="sev-info">[empty]</span>' : ''}</td><td>${c.duration_ms ?? '—'}</td></tr>`).join('')}
</table>` : '<div class="empty">No router calls yet.</div>'}

</body></html>`
}
