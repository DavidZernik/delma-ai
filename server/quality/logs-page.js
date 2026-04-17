// Renders the /logs HTML page(s). Public, no auth — internal observability.
//
// Two views, same endpoint:
//   /logs            → list of recent runs as cards. Each card shows the
//                      run trigger, narratives, average score, and the
//                      Sonnet-generated "what to act on" summary. Below
//                      the list: cross-run candidate-eval triage queue.
//   /logs?run=<id>   → detail view for a single run. Shows only that run's
//                      narratives, critiques, regression evals, state
//                      hygiene findings, and candidate evals.
//
// Older rows (pre-migration 014) have run_id = null; they surface on the
// home view as a single "ungrouped" section so nothing is hidden.
//
// Rendered server-side as plain HTML. No client JS.

import { supabase as sb } from '../lib/supabase.js'

const css = `
  body { font-family: -apple-system, system-ui, sans-serif; max-width: 1100px; margin: 0 auto; padding: 24px; background: #FBF8F2; color: #2B1F1F; }
  h1 { font-size: 24px; margin: 0 0 4px; }
  h1 a { color: inherit; text-decoration: none; }
  .subtitle { color: #6B5A5A; font-size: 13px; margin-bottom: 24px; }
  h2 { font-size: 16px; margin: 32px 0 8px; padding-bottom: 4px; border-bottom: 2px solid #7A1E1E; color: #7A1E1E; text-transform: uppercase; letter-spacing: 0.05em; }
  h3 { font-size: 14px; margin: 18px 0 6px; color: #2B1F1F; }
  a { color: #7A1E1E; }
  .run-card { background: #FFFFFF; border: 1px solid #E8D8D2; border-radius: 8px; margin: 12px 0; padding: 16px 20px; display: block; text-decoration: none; color: inherit; transition: background 0.1s; }
  .run-card:hover { background: #FFFCF5; }
  .run-card .head { display: flex; justify-content: space-between; align-items: flex-start; gap: 16px; margin-bottom: 10px; flex-wrap: wrap; }
  .run-card .title { font-size: 15px; font-weight: 600; color: #2B1F1F; margin: 0; }
  .run-card .meta { font-size: 11px; color: #6B5A5A; margin-top: 4px; }
  .run-card .score-pill { font-size: 13px; font-weight: 600; padding: 4px 12px; border-radius: 99px; background: #FAF3E6; color: #8A5A00; white-space: nowrap; }
  .run-card .score-pill.good { background: #E9F2E2; color: #3F6B25; }
  .run-card .score-pill.mid { background: #FAF3E6; color: #8A5A00; }
  .run-card .score-pill.bad { background: #FCE9E6; color: #A73; }
  .run-card .summary { font-size: 13px; line-height: 1.55; color: #2B1F1F; margin: 8px 0 4px; white-space: pre-wrap; }
  .run-card .footer { font-size: 11px; color: #6B5A5A; margin-top: 10px; padding-top: 10px; border-top: 1px dashed #F0E5E0; display: flex; gap: 18px; flex-wrap: wrap; }
  .trigger-pill { display: inline-block; font-size: 10px; text-transform: uppercase; letter-spacing: 0.06em; padding: 2px 8px; border-radius: 4px; background: #F4F0EA; color: #6B5A5A; margin-right: 6px; }
  .trigger-pill.overnight { background: #EAE6F2; color: #4B3D7A; }
  .trigger-pill.smoke { background: #F4ECE6; color: #6B4823; }
  .status-running { color: #C56F2B; font-weight: 600; }
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
  .sev-wrong { color: #B33; font-weight: 600; }
  .sev-suspicious { color: #C56F2B; }
  .sev-info { color: #6B5A5A; }
  .sev-warn { color: #C56F2B; }
  pre { background: #F4F0EA; padding: 8px; border-radius: 4px; font-size: 11px; overflow-x: auto; margin: 0; }
  code { font-family: ui-monospace, monospace; font-size: 11px; background: #F4F0EA; padding: 1px 4px; border-radius: 3px; }
  .ts { color: #6B5A5A; font-size: 11px; white-space: nowrap; }
  .empty { color: #6B5A5A; font-style: italic; padding: 12px; }
  details summary { cursor: pointer; color: #7A1E1E; font-size: 12px; }
  .sim-card { background: #FFFFFF; border: 1px solid #E8D8D2; border-radius: 8px; margin: 12px 0; padding: 14px 18px; }
  .sim-card summary { cursor: pointer; font-size: 14px; }
  .sim-card .sim-body { margin-top: 14px; }
  .sim-card h4 { font-size: 12px; text-transform: uppercase; letter-spacing: 0.05em; margin: 18px 0 6px; }
  .sim-card ul { margin: 4px 0 8px 18px; padding: 0; }
  .sim-card li { margin: 2px 0; font-size: 13px; }
  .sim-scores { font-size: 12px; color: #6B5A5A; margin-bottom: 8px; }
  .transcript { background: #FBF8F2; border-radius: 6px; padding: 8px 12px; margin: 8px 0; max-height: 460px; overflow-y: auto; }
  .transcript > div { padding: 6px 0; border-bottom: 1px solid #F0E5E0; font-size: 13px; }
  .t-label { display: inline-block; min-width: 56px; font-weight: 600; font-size: 11px; text-transform: uppercase; color: #6B5A5A; }
  .t-user .t-label { color: #7A1E1E; }
  .t-claude .t-label { color: #6B8E5C; }
  .t-ops { margin-top: 4px; margin-left: 56px; }
  .t-ops code { font-size: 10px; margin-right: 4px; }
  .back { display: inline-block; margin-bottom: 12px; font-size: 12px; }
  @media (max-width: 640px) {
    body { padding: 12px; max-width: 100%; }
    h1 { font-size: 20px; }
    h2 { font-size: 14px; }
    .summary { grid-template-columns: 1fr 1fr; }
    table { font-size: 11px; display: block; overflow-x: auto; max-width: 100%; }
    .transcript { font-size: 12px; }
  }
`

const esc = (s) => String(s ?? '').replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]))
const ago = (iso) => {
  if (!iso) return '—'
  const ms = Date.now() - new Date(iso).getTime()
  const m = Math.floor(ms / 60000)
  if (m < 1) return 'just now'
  if (m < 60) return `${m}m ago`
  const h = Math.floor(m / 60)
  if (h < 24) return `${h}h ago`
  return `${Math.floor(h / 24)}d ago`
}

// Lightweight markdown → HTML. Handles headings, bullets, bold, line breaks.
// Used for Sonnet-generated run summaries which are plain markdown.
function md(text) {
  if (!text) return ''
  const lines = String(text).split('\n')
  const out = []
  let inList = false
  for (let raw of lines) {
    const line = raw.trim()
    if (!line) { if (inList) { out.push('</ul>'); inList = false } out.push('<br/>'); continue }
    if (line.startsWith('- ') || line.startsWith('* ')) {
      if (!inList) { out.push('<ul>'); inList = true }
      out.push(`<li>${inline(line.slice(2))}</li>`)
      continue
    }
    if (inList) { out.push('</ul>'); inList = false }
    if (line.startsWith('### ')) { out.push(`<h4>${inline(line.slice(4))}</h4>`); continue }
    if (line.startsWith('## '))  { out.push(`<h3>${inline(line.slice(3))}</h3>`); continue }
    if (line.startsWith('# '))   { out.push(`<h2>${inline(line.slice(2))}</h2>`); continue }
    out.push(`<p>${inline(line)}</p>`)
  }
  if (inList) out.push('</ul>')
  return out.join('\n')
}

function inline(s) {
  return esc(s)
    .replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>')
    .replace(/`(.+?)`/g, '<code>$1</code>')
}

function scoreClass(score) {
  if (score == null) return ''
  if (score >= 4) return 'good'
  if (score >= 3) return 'mid'
  return 'bad'
}

function triggerClass(t) {
  if (!t) return ''
  if (t.startsWith('overnight')) return 'overnight'
  return 'smoke'
}

// ── Top-level dispatch ──────────────────────────────────────────────────

export async function renderLogsPage(runId = null) {
  if (runId) return renderRunDetail(runId)
  return renderRunList()
}

// ── Home view: list of runs ─────────────────────────────────────────────

async function renderRunList() {
  const [{ data: runs }, { data: candRaw }] = await Promise.all([
    sb.from('quality_runs').select('*').order('started_at', { ascending: false }).limit(30),
    sb.from('quality_candidate_evals')
      .select('id, found_at, category, finding_text, run_id, source_simulation_id, status')
      .eq('status', 'pending').order('found_at', { ascending: false }).limit(30)
  ])

  // Top-of-page at-a-glance numbers. Only counts complete runs so the
  // score averages aren't polluted by in-progress ones that haven't
  // scored their narratives yet.
  const today = new Date(); today.setHours(0, 0, 0, 0)
  const runsToday = (runs || []).filter(r => new Date(r.started_at) >= today)
  const completeToday = runsToday.filter(r => r.status === 'complete' && r.overall_score != null)
  const avgToday = completeToday.length
    ? (completeToday.reduce((a, b) => a + Number(b.overall_score), 0) / completeToday.length).toFixed(2)
    : '—'
  const latest = runs?.[0]
  const running = (runs || []).filter(r => r.status === 'running').length

  const headerStats = latest
    ? `<div class="summary">
        <div class="stat"><div class="num">${runsToday.length}</div><div class="lab">Runs today</div></div>
        <div class="stat"><div class="num">${avgToday}</div><div class="lab">Avg score today</div></div>
        <div class="stat"><div class="num">${ago(latest.started_at).replace(' ago', '')}</div><div class="lab">Latest run</div></div>
        ${running ? `<div class="stat"><div class="num status-running">⟳ ${running}</div><div class="lab">Running now</div></div>` : ''}
      </div>`
    : ''

  const body = `
    <h1>Delma Quality Lab</h1>
    <div class="subtitle">Every smoke or overnight test fires a run. Each card is one run with its own summary. Click through for full detail.</div>

    ${headerStats}

    <h2>Runs — latest first</h2>
    ${(runs || []).length === 0 ? `<div class="empty">No runs yet. Fire one with <code>npm run smoke</code> or <code>npm run overnight</code>.</div>` :
      runs.map(r => renderRunCard(r)).join('')
    }

    <h2>Candidate eval queue (cross-run)</h2>
    <div style="color:#6B5A5A; font-size:12px; margin-bottom:8px;">Critic findings auto-filed from all runs. Triage: accept → add to permanent regression suite, reject if mis-grade.</div>
    ${(candRaw || []).length === 0 ? `<div class="empty">Queue clear.</div>` : `
      <table>
        <thead><tr><th>When</th><th>Category</th><th>Finding</th><th>From</th></tr></thead>
        <tbody>
          ${candRaw.map(c => `
            <tr>
              <td class="ts">${ago(c.found_at)}</td>
              <td class="sev-${c.category === 'wrong' ? 'wrong' : 'suspicious'}">${esc(c.category)}</td>
              <td>${esc(c.finding_text).slice(0, 240)}</td>
              <td class="ts">${c.run_id ? `<a href="/logs?run=${c.run_id}">run</a>` : `sim#${c.source_simulation_id || '—'}`}</td>
            </tr>
          `).join('')}
        </tbody>
      </table>
    `}
  `
  return wrap('Delma Quality Lab', body)
}

function renderRunCard(r) {
  const scoreTxt = r.overall_score != null ? `${r.overall_score}/5` : (r.status === 'running' ? 'running…' : '—')
  const scoreCls = scoreClass(r.overall_score)
  const tCls = triggerClass(r.trigger)
  const title = r.label || r.trigger
  const narratives = (r.narratives_run || []).slice(0, 5)
  const moreNarr = (r.narratives_run || []).length - narratives.length
  const statusHtml = r.status === 'running' ? `<span class="status-running">⟳ running</span>` : `${ago(r.ended_at || r.started_at)}`
  const summaryHtml = r.summary ? md(r.summary) : (r.status === 'running' ? '<p style="color:#6B5A5A;font-style:italic;">Summary will appear here when the run completes.</p>' : '<p style="color:#6B5A5A;font-style:italic;">No summary available.</p>')
  const fidTxt = r.avg_fidelity != null ? `${r.avg_fidelity}%` : null

  return `
    <a class="run-card" href="/logs?run=${r.id}">
      <div class="head">
        <div>
          <h3 class="title"><span class="trigger-pill ${tCls}">${esc(r.trigger)}</span>${esc(title.replace(r.trigger + ': ', ''))}</h3>
          <div class="meta">${statusHtml} · ${r.num_complete || 0}/${r.num_narratives || 0} narratives${narratives.length ? ' · ' + narratives.map(esc).join(', ') : ''}${moreNarr > 0 ? ` (+${moreNarr})` : ''}</div>
        </div>
        <div style="display:flex;flex-direction:column;gap:4px;align-items:flex-end;">
          <div class="score-pill ${scoreCls}">${scoreTxt}</div>
          ${fidTxt ? `<div class="score-pill" style="font-size:10px;padding:2px 8px;background:#F4ECE6;color:#6B4823;">${fidTxt} fidelity</div>` : ''}
        </div>
      </div>
      <div class="summary">${summaryHtml}</div>
      <div class="footer">
        ${r.num_candidates ? `<span>📝 ${r.num_candidates} candidate${r.num_candidates === 1 ? '' : 's'} filed</span>` : ''}
        ${r.num_regression_fails ? `<span class="fail">✗ ${r.num_regression_fails} regression fail${r.num_regression_fails === 1 ? '' : 's'}</span>` : r.ran_regression ? `<span class="pass">✓ evals passing</span>` : ''}
        ${r.num_state_warnings ? `<span>⚠ ${r.num_state_warnings} state warnings</span>` : ''}
        <span>View details →</span>
      </div>
    </a>
  `
}

// ── Detail view: a single run ───────────────────────────────────────────

async function renderRunDetail(runId) {
  const [{ data: run }, { data: sims }, { data: evals }, { data: candidates }, { data: stateChecks }, { data: signals }] = await Promise.all([
    sb.from('quality_runs').select('*').eq('id', runId).maybeSingle(),
    sb.from('quality_simulations').select('*').eq('run_id', runId).order('ran_at', { ascending: true }),
    sb.from('quality_eval_runs').select('*').eq('run_id', runId).order('run_at', { ascending: true }),
    sb.from('quality_candidate_evals').select('*').eq('run_id', runId).order('found_at', { ascending: true }),
    sb.from('quality_state_checks').select('*').eq('run_id', runId).order('checked_at', { ascending: true }),
    sb.from('quality_signals').select('*').eq('run_id', runId).order('checked_at', { ascending: true })
  ])

  if (!run) {
    return wrap('Run not found', `<a class="back" href="/logs">← All runs</a><div class="empty">No run with id ${esc(runId)}.</div>`)
  }

  const scoreTxt = run.overall_score != null ? `${run.overall_score}/5` : (run.status === 'running' ? 'running…' : '—')
  const duration = run.ended_at ? Math.round((new Date(run.ended_at) - new Date(run.started_at)) / 1000) : null

  const isRunning = run.status === 'running'

  const body = `
    <a class="back" href="/logs">← All runs</a>
    <h1>${esc(run.label || run.trigger)}</h1>
    <div class="subtitle">
      <span class="trigger-pill ${triggerClass(run.trigger)}">${esc(run.trigger)}</span>
      ${ago(run.started_at)}${duration ? ` · ${duration}s` : ''}${isRunning ? ` · <span class="status-running">⟳ running</span>` : ''}
    </div>

    ${isRunning ? `
      <div style="background:#FAF3E6; border-left:4px solid #C56F2B; padding:12px 16px; border-radius:4px; margin:12px 0; font-size:13px;">
        <strong>Run in progress</strong> — narratives score one at a time. This page doesn't auto-refresh; reload to see new results as they land.
        ${run.num_narratives ? `<div style="margin-top:6px; color:#6B5A5A;">Progress: ${run.num_complete || 0}/${run.num_narratives} narratives complete</div>` : ''}
      </div>
    ` : ''}

    <h2>Summary</h2>
    <div class="exec-summary" style="background:#FFFFFF; border-left:4px solid #7A1E1E; padding:14px 18px; border-radius:4px; line-height:1.55;">
      ${run.summary ? md(run.summary) : (isRunning ? '<div class="empty">Summary will be generated when the run completes.</div>' : '<div class="empty">No summary available.</div>')}
    </div>

    <div class="summary">
      <div class="stat"><div class="num">${scoreTxt}</div><div class="lab">Quality (Sonnet)</div></div>
      <div class="stat"><div class="num">${run.avg_fidelity != null ? run.avg_fidelity + '%' : '—'}</div><div class="lab">Fidelity (deterministic)</div></div>
      <div class="stat"><div class="num">${run.num_complete || 0}/${run.num_narratives || 0}</div><div class="lab">Narratives</div></div>
      <div class="stat"><div class="num">${run.num_regression_fails ?? 0}</div><div class="lab">Regression Fails</div></div>
      <div class="stat"><div class="num">${run.num_candidates ?? 0}</div><div class="lab">Candidate Evals</div></div>
    </div>

    <h2>Narratives (${(sims || []).length})</h2>
    ${(sims || []).length === 0 ? '<div class="empty">No narratives scored in this run yet.</div>' :
      sims.map(s => renderSim(s)).join('')
    }

    <h2>Regression Evals (${(evals || []).length})</h2>
    ${renderEvalsForRun(evals)}

    <h2>Candidate Evals from this run (${(candidates || []).length})</h2>
    ${(candidates || []).length === 0 ? '<div class="empty">No findings filed from this run.</div>' : `
      <table>
        <thead><tr><th>Category</th><th>Finding</th><th>From sim</th></tr></thead>
        <tbody>
          ${candidates.map(c => `
            <tr>
              <td class="sev-${c.category === 'wrong' ? 'wrong' : 'suspicious'}">${esc(c.category)}</td>
              <td>${esc(c.finding_text)}</td>
              <td class="ts">${c.source_simulation_id ? `sim#${c.source_simulation_id}` : '—'}</td>
            </tr>
          `).join('')}
        </tbody>
      </table>
    `}

    <h2>State Hygiene (${(stateChecks || []).length})</h2>
    ${(stateChecks || []).length === 0 ? '<div class="empty">No state issues flagged in this run.</div>' : `
      <table>
        <thead><tr><th>Check</th><th>Severity</th><th>Detail</th></tr></thead>
        <tbody>
          ${stateChecks.map(s => `
            <tr>
              <td><code>${esc(s.check_name)}</code></td>
              <td class="sev-${s.severity}">${esc(s.severity)}</td>
              <td>${esc(s.detail)}</td>
            </tr>
          `).join('')}
        </tbody>
      </table>
    `}

    <h2>Router Signal Mining (${(signals || []).length})</h2>
    ${(signals || []).length === 0 ? '<div class="empty">No router signals from this run.</div>' : `
      <table>
        <thead><tr><th>Pattern</th><th>Count</th><th>Examples</th><th>Suggestion</th></tr></thead>
        <tbody>
          ${signals.map(s => `
            <tr>
              <td><code>${esc(s.pattern)}</code></td>
              <td class="ts">${s.count ?? 0}</td>
              <td>${esc((s.examples || []).slice(0, 3).join(' · ')).slice(0, 200) || '—'}</td>
              <td>${esc(s.suggestion || '—')}</td>
            </tr>
          `).join('')}
        </tbody>
      </table>
    `}
  `
  return wrap(`${run.label || run.trigger} — Delma Quality Lab`, body)
}

function renderEvalsForRun(evalRows) {
  // Each row is a per-case result from runCases; we bundled them into one
  // insert with `results: [...]`. Older schema may have one row per case.
  if (!evalRows || !evalRows.length) return '<div class="empty">Regression evals did not run in this run.</div>'
  const first = evalRows[0]
  const results = Array.isArray(first.results) ? first.results : evalRows.map(r => ({
    name: r.case_name, pass: r.pass, ms: r.ms, error: (r.failure_reasons || [])[0] || null
  }))
  if (!results.length) return '<div class="empty">No eval cases.</div>'
  return `
    <table class="mini">
      <thead><tr><th>Case</th><th>Result</th><th>ms</th><th>Notes</th></tr></thead>
      <tbody>
        ${results.map(r => `
          <tr>
            <td>${esc(r.name)}</td>
            <td class="${r.pass ? 'pass' : 'fail'}">${r.pass ? '✓ pass' : '✗ fail'}</td>
            <td class="ts">${r.ms || '—'}</td>
            <td>${esc(r.error || '—')}</td>
          </tr>
        `).join('')}
      </tbody>
    </table>
  `
}

function renderSim(s) {
  const nar = s.transcript?.narrative_id || 'unknown'
  const title = s.transcript?.narrative_title || nar
  const sc = s.critique?.scores || {}
  const scoreCls = scoreClass(s.overall_score)
  const fid = s.fidelity_detail || null

  return `
    <details class="sim-card">
      <summary>
        <strong>${esc(title)}</strong> ·
        <span class="score-pill ${scoreCls}" style="padding:2px 8px;font-size:11px;">${s.overall_score ?? '?'}/5</span> ·
        ${s.fidelity_score != null ? `<span class="score-pill" style="padding:2px 8px;font-size:11px;background:#F4ECE6;color:#6B4823;">${s.fidelity_score}% fidelity</span> ·` : ''}
        <span class="ts">${Math.round((s.total_duration_ms || 0) / 1000)}s · ${(s.ops_applied || []).length} ops</span>
      </summary>
      <div class="sim-body">
        <p>${esc(s.critique?.summary || '(no summary)')}</p>
        <div class="sim-scores">
          accuracy: ${sc.accuracy ?? '?'}/5 ·
          coverage: ${sc.coverage ?? '?'}/5 ·
          timeliness: ${sc.timeliness ?? '?'}/5 ·
          correctness: ${sc.correctness ?? '?'}/5
        </div>
        ${fid ? `
          <h4>Fidelity (${fid.matched}/${fid.expected} expected items captured, ${fid.percent}%)</h4>
          <div style="font-size:12px; color:#6B5A5A;">
            <table class="mini" style="margin-top:4px;">
              <thead><tr><th>Tab</th><th>Captured</th><th>Missing</th></tr></thead>
              <tbody>
                ${Object.entries(fid.per_tab).filter(([,v]) => v.expected > 0).map(([tab, v]) => `
                  <tr>
                    <td><code>${esc(tab)}</code></td>
                    <td class="ts">${v.matched}/${v.expected}</td>
                    <td>${v.missed.length ? v.missed.map(m => esc(m)).join(' · ') : '<span class="pass">all captured</span>'}</td>
                  </tr>
                `).join('')}
              </tbody>
            </table>
            ${fid.forbidden_hits > 0 ? `<div style="color:#B33; margin-top:6px;">⚠ ${fid.forbidden_hits} forbidden item(s) captured: ${(fid.forbidden || []).map(f => esc(f.forbidden)).join(', ')}</div>` : ''}
          </div>
        ` : ''}
        ${s.critique?.wrong?.length ? `<h4>What Delma got wrong</h4><ul>${s.critique.wrong.map(w => `<li>${esc(w)}</li>`).join('')}</ul>` : ''}
        ${s.critique?.missed?.length ? `<h4>What was missed</h4><ul>${s.critique.missed.map(m => `<li>${esc(m)}</li>`).join('')}</ul>` : ''}
        ${s.critique?.praise?.length ? `<h4>What worked</h4><ul>${s.critique.praise.map(p => `<li>${esc(p)}</li>`).join('')}</ul>` : ''}
        ${s.transcript?.turns?.length ? `
          <h4>Conversation transcript</h4>
          <div class="transcript">
            ${s.transcript.turns.map(t => `
              <div class="t-${t.role}">
                <span class="t-label">${t.role}</span><span class="t-text">${esc(t.text)}</span>
                ${t.ops?.length ? `<div class="t-ops">${t.ops.map(o => `<code>${esc(o.tab)}/${esc(o.op)}</code>`).join('')}</div>` : ''}
              </div>
            `).join('')}
          </div>
        ` : ''}
      </div>
    </details>
  `
}

// ── Wrapper ──────────────────────────────────────────────────────────────

function wrap(title, body) {
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>${esc(title)}</title>
  <style>${css}</style>
</head>
<body>
${body}
</body>
</html>`
}
