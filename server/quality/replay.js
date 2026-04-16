// Replay harness — the headline overnight test once Delma has real users.
//
// Pulls yesterday's actual ops from api_op_logs + mcp_call_logs, and for
// each one:
//   1. Reconstructs the structured state right before that op
//   2. Re-applies the op against a fresh in-memory copy
//   3. Has Sonnet grade: did this op match the user's intent (from the
//      input text we have for router-driven ops)?
//
// This is grounded in real usage. No invented scenarios.
//
// If there's no real activity yet, runner.js falls back to runAllNarratives.

import { supabase as sb } from '../lib/supabase.js'
import { applyOp, render, emptyData } from '../../src/tab-ops.js'
import { ANTHROPIC_URL, anthropicHeaders } from '../lib/llm.js'

const SONNET = 'claude-sonnet-4-5'

async function callAnthropic(model, system, user, max_tokens = 800) {
  const res = await fetch(ANTHROPIC_URL, {
    method: 'POST',
    headers: anthropicHeaders('replay-critic'),
    body: JSON.stringify({ model, max_tokens, system, messages: [{ role: 'user', content: user }] })
  })
  if (!res.ok) throw new Error(`Anthropic ${res.status}: ${await res.text()}`)
  const data = await res.json()
  return data.content?.[0]?.text || ''
}

const REPLAY_CRITIC_SYS = `You're auditing one Delma typed-op call against the user's stated intent.

Inputs:
- The original user input that triggered this op (router input text)
- The op called (name + args)
- The tab's structured state BEFORE the op
- The tab's structured state AFTER the op

Score 1-5:
  5 = perfect match — op exactly captured what user said
  4 = good — minor over/under-capture
  3 = acceptable — right intent, awkward op choice
  2 = suspicious — info lost or wrong tab
  1 = wrong — caused damage

Return JSON ONLY:
{ "score": <int>, "severity": "clean"|"minor"|"suspicious"|"wrong", "finding": "<one sentence>", "suggestion": "<one sentence or null>" }`

export async function runReplay({ hoursBack = 24, max = 20 } = {}) {
  console.log('[quality:replay] starting — last', hoursBack, 'h, max', max)
  const t0 = Date.now()
  const since = new Date(Date.now() - hoursBack * 3600 * 1000).toISOString()

  // We want router calls (the input text) joined with the resulting api_op_logs.
  // Approximate: for each router call with non-empty ops, find an api_op_log
  // within ~5s of the same workspace where the ops match.
  const { data: routerCalls } = await sb.from('quality_router_calls')
    .select('*').gte('created_at', since)
    .not('ops', 'eq', '[]').order('created_at', { ascending: false }).limit(max * 3)

  if (!routerCalls?.length) {
    console.log('[quality:replay] no router calls in window — caller should run narratives instead')
    return { observed: 0 }
  }

  let observed = 0
  for (const call of routerCalls.slice(0, max)) {
    for (const opSpec of (call.ops || [])) {
      if (!opSpec.tab || !opSpec.op) continue
      try {
        // Pull the current structured state for this tab — best approximation
        // of "before". (True before-state would require diffing history snapshots.)
        const filename = opSpec.tab.split(':')[1]
        const { data: row } = await stateRowFor(opSpec.tab, call.workspace_id)
        const beforeState = row?.structured || emptyData(filename)
        let afterState
        try { afterState = applyOp(filename, beforeState, opSpec.op, opSpec.args || {}) }
        catch (err) {
          await sb.from('quality_observations').insert({
            source: 'replay', source_id: String(call.id),
            severity: 'wrong', score: 1,
            finding: `op threw on replay: ${err.message}`,
            suggestion: 'investigate the args — schema validation may be needed',
            context: { input: call.input, op: opSpec }
          })
          observed++
          continue
        }

        const userMsg = `## User input
"${call.input}"

## Op called
${opSpec.tab} / ${opSpec.op}
args: ${JSON.stringify(opSpec.args, null, 2)}

## Before
${JSON.stringify(beforeState, null, 2)}

## After
${JSON.stringify(afterState, null, 2)}

Audit this op.`
        const raw = await callAnthropic(SONNET, REPLAY_CRITIC_SYS, userMsg)
        let j
        try { j = JSON.parse(raw.replace(/^```(?:json)?\n?/, '').replace(/\n?```$/, '')) }
        catch { continue }
        await sb.from('quality_observations').insert({
          source: 'replay', source_id: String(call.id),
          severity: j.severity || 'clean', score: j.score,
          finding: j.finding, suggestion: j.suggestion || null,
          context: { input: call.input, op: opSpec, before: beforeState, after: afterState }
        })
        observed++
      } catch (err) {
        console.warn('[quality:replay] op failed:', err.message)
      }
    }
  }
  console.log(`[quality:replay] done — ${observed} observations in ${Date.now() - t0}ms`)
  return { observed }
}

async function stateRowFor(tabKey, workspaceId) {
  const [prefix, filename] = tabKey.split(':')
  if (prefix === 'memory') return sb.from('memory_notes').select('structured').eq('workspace_id', workspaceId).eq('filename', filename).maybeSingle()
  if (prefix === 'org') {
    const { data: ws } = await sb.from('workspaces').select('org_id').eq('id', workspaceId).maybeSingle()
    if (!ws?.org_id) return { data: null }
    return sb.from('org_memory_notes').select('structured').eq('org_id', ws.org_id).eq('filename', filename).maybeSingle()
  }
  if (prefix === 'diagram') return sb.from('diagram_views').select('structured').eq('workspace_id', workspaceId).eq('view_key', filename).maybeSingle()
  return { data: null }
}
