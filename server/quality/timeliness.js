// Timeliness analyzer — pure JS/SQL, no LLM.
//
// Splits two distinct failure modes (per David's framing):
//
//   MODE A — "Claude was slow to call the tool"
//     Claude Code saw the relevant info in conversation but processed
//     several more messages before deciding to call MCP. NOT a Delma bug;
//     a Claude behavior issue (probably an instruction-in-CLAUDE.md fix).
//     Measurable when we have both timestamps: the message that mentioned
//     X vs the MCP call that captured X.
//       - For narratives/replay: we have both → we can flag deferred capture
//       - For real Claude Code MCP calls: we don't have message timestamps
//         from the chat itself, so we approximate via gap-between-calls
//
//   MODE B — "Delma applied the op slowly"
//     Op arrived at the server but took too long. Pure Delma responsibility.
//     Already measured by api_op_logs.duration_ms / mcp_call_logs.duration_ms.
//
// Findings persist to quality_signals.

import { supabase as sb } from '../lib/supabase.js'

const p = (arr, q) => arr.length ? arr[Math.min(arr.length - 1, Math.floor(arr.length * q))] : null

export async function runTimeliness({ hoursBack = 24 } = {}) {
  const since = new Date(Date.now() - hoursBack * 3600 * 1000).toISOString()

  const [{ data: routerCalls }, { data: opLogs }, { data: mcpLogs }] = await Promise.all([
    sb.from('quality_router_calls').select('id, created_at, duration_ms, ops, workspace_id').gte('created_at', since),
    sb.from('api_op_logs').select('id, created_at, duration_ms, tab_key, ops, workspace_id').gte('created_at', since),
    sb.from('mcp_call_logs').select('id, created_at, duration_ms, tool, workspace_id, success').gte('created_at', since)
  ])

  const router = routerCalls || []
  const ops = opLogs || []
  const mcp = mcpLogs || []

  const findings = []

  // ── MODE B: Delma server-side latency (op application) ─────────────
  if (ops.length) {
    const opMs = ops.map(o => o.duration_ms).filter(x => x != null).sort((a, b) => a - b)
    const slowOps = ops.filter(o => (o.duration_ms || 0) > 3000)
    findings.push({
      pattern: 'mode_b__delma_op_latency',
      count: ops.length,
      examples: [`p50 ${p(opMs, 0.5)}ms, p90 ${p(opMs, 0.9)}ms, slowest ${opMs[opMs.length - 1]}ms`],
      suggestion: slowOps.length
        ? `${slowOps.length} op application(s) >3s — DB write, parse, or render bottleneck. Check the slowest tab_key.`
        : null
    })
  }
  if (mcp.length) {
    const mcpMs = mcp.map(m => m.duration_ms).filter(x => x != null).sort((a, b) => a - b)
    const slowMcp = mcp.filter(m => (m.duration_ms || 0) > 3000)
    findings.push({
      pattern: 'mode_b__mcp_handler_latency',
      count: mcp.length,
      examples: [`p50 ${p(mcpMs, 0.5)}ms, p90 ${p(mcpMs, 0.9)}ms, slowest ${mcpMs[mcpMs.length - 1]}ms`],
      suggestion: slowMcp.length
        ? `${slowMcp.length} MCP tool call(s) >3s on the server side — Delma's handler is slow.`
        : null
    })
  }

  // ── MODE A (web-router slice we CAN measure): router decision → op apply ──
  // We have the router input timestamp and the resulting api_op timestamp,
  // both server-side. Anything large here = we showed Claude/Haiku the input
  // and it took N seconds before the op landed in the DB. Pure Delma chain.
  const e2eLags = []
  for (const op of ops) {
    const opT = new Date(op.created_at).getTime()
    const candidates = router.filter(r =>
      r.workspace_id === op.workspace_id &&
      new Date(r.created_at).getTime() <= opT &&
      (opT - new Date(r.created_at).getTime()) < 10000)
    if (candidates.length) {
      const closest = candidates.reduce((a, b) => (new Date(b.created_at) > new Date(a.created_at) ? b : a))
      e2eLags.push(opT - new Date(closest.created_at).getTime())
    }
  }
  e2eLags.sort((a, b) => a - b)
  if (e2eLags.length) {
    findings.push({
      pattern: 'router_input_to_op_applied',
      count: e2eLags.length,
      examples: [`p50 ${p(e2eLags, 0.5)}ms, p90 ${p(e2eLags, 0.9)}ms, slowest ${e2eLags[e2eLags.length - 1]}ms`],
      suggestion: 'End-to-end web-side latency users perceive (typed-input → diagram updates).'
    })
  }

  // ── MODE A (real Claude Code MCP): "Claude was slow to call the tool" ──
  // We have conversation_ticks from inject-claude-md.sh — one row per user
  // message. For each MCP call, find the most recent tick in the same
  // workspace BEFORE the call. Lag = call_time - tick_time. If the lag is
  // > one expected turn (~30s), Claude likely processed several messages
  // before deciding to call the tool. That's Mode A.
  const { data: tickRows } = await sb.from('conversation_ticks')
    .select('ts, workspace_id').gte('ts', since).limit(2000)
  const ticks = tickRows || []

  if (ticks.length && mcp.length) {
    const ticksByWs = {}
    for (const t of ticks) (ticksByWs[t.workspace_id] ||= []).push(new Date(t.ts).getTime())
    for (const arr of Object.values(ticksByWs)) arr.sort((a, b) => a - b)

    const lags = []
    for (const m of mcp) {
      if (!m.workspace_id) continue
      const arr = ticksByWs[m.workspace_id] || []
      const callT = new Date(m.created_at).getTime()
      // Most recent tick BEFORE the call
      let last = null
      for (const t of arr) { if (t <= callT) last = t; else break }
      if (last != null) lags.push(callT - last)
    }
    lags.sort((a, b) => a - b)
    const deferred = lags.filter(l => l > 30000).length  // > 30s = likely deferred
    if (lags.length) {
      findings.push({
        pattern: 'mode_a__claude_call_promptness',
        count: lags.length,
        examples: [
          `tick→MCP-call lag p50 ${p(lags, 0.5)}ms, p90 ${p(lags, 0.9)}ms, slowest ${lags[lags.length - 1]}ms`,
          `${deferred} call(s) appeared >30s after the most recent user message — likely deferred capture`
        ],
        suggestion: deferred
          ? `${deferred} MCP call(s) fired more than 30s after the user message that prompted them. Claude may be deferring captures. Consider tightening CLAUDE.md instructions about when to call MCP.`
          : 'All captures arrived within ~30s of the message — Claude is being prompt.'
      })
    }
  } else {
    // No ticks yet (hook not deployed or no Claude Code activity)
    findings.push({
      pattern: 'mode_a__no_data',
      count: 0,
      examples: [`${ticks.length} ticks, ${mcp.length} MCP calls in window`],
      suggestion: 'Deploy hooks/inject-claude-md.sh and exercise Claude Code; ticks will start arriving on every user message.'
    })
  }

  if (findings.length) await sb.from('quality_signals').insert(findings)
  return { findings: findings.length }
}
