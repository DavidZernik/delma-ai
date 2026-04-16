// Curated narrative scripts — full-arc "workdays" we can run Delma against
// when there's no real production traffic to replay.
//
// Each script is a 6-12 turn user-side conversation tied to a structured
// "expected outcome" the critic uses as ground truth. These are NOT random
// synthetic cases — they're stories deliberately written to exercise:
//   - multi-tab fan-out
//   - corrections / scope changes mid-arc
//   - long-tail facts spread across turns
//   - tab-routing edge cases
//
// Adding a new narrative = adding institutional knowledge about what
// "good behavior" looks like. Edit thoughtfully.

import { OPS_BY_TAB } from '../../src/tab-ops.js'
import { applyOpsToTab, parseTabKey } from '../lib/apply-op.js'
import { supabase as sb } from '../lib/supabase.js'

const HAIKU = 'claude-haiku-4-5'
const SONNET = 'claude-sonnet-4-5'

async function callAnthropic(model, system, messages, max_tokens = 1500) {
  const res = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-api-key': process.env.ANTHROPIC_API_KEY, 'anthropic-version': '2023-06-01' },
    body: JSON.stringify({ model, max_tokens, system, messages: Array.isArray(messages) ? messages : [{ role: 'user', content: messages }] })
  })
  if (!res.ok) throw new Error(`Anthropic ${res.status}: ${await res.text()}`)
  const data = await res.json()
  return data.content?.[0]?.text || ''
}

// ── The narratives ────────────────────────────────────────────────────────

export const NARRATIVES = [
  {
    id: 'pm-onboarding',
    title: 'PM onboarding a new SFMC project',
    turns: [
      "Hi! I'm Sarah, the new PM. I'm taking over the Birthday Campaign project from Mike. Can you help me get organized?",
      "We have a small team: I'm the PM, Keyona Abbott is the engineer doing the SFMC build, and Mike Davis from product is our stakeholder.",
      "Wait actually Keyona reports to me. And Mike isn't really involved day-to-day, he's more of an exec sponsor.",
      "The main rule we have: nothing ships on Fridays. Legal needs 48h to review.",
      "Our SFMC sender profile is SP_Birthday_Main. Source DE is BirthdayPatients_Daily.",
      "We just decided to use a single email template for all birthday segments — that's a change from last quarter when we had four. Owner is Keyona.",
      "Action item: Keyona needs to update the journey to point at the new single template by next Friday.",
      "Architecture-wise: there's a daily automation that runs at 5am, queries the source DE, and feeds the BirthdayJourney which sends WelcomeEmail.",
      "Also for the architecture: group the daily auto + query into a 'Daily Filter' layer.",
      "Looks good! Anything I missed?"
    ],
    expected: {
      people: ['Sarah (PM)', 'Keyona Abbott (Engineer, reports to Sarah)', 'Mike Davis (exec sponsor / stakeholder)'],
      decisions: ['Use single email template for all birthday segments (Keyona)'],
      actions: ['Keyona: update journey to single template (due Friday)'],
      environment: ['SP_Birthday_Main (sender profile)', 'BirthdayPatients_Daily (source DE)'],
      playbook: ['No Friday launches (legal needs 48h)'],
      architecture: ['Nodes: daily auto, query, BirthdayJourney, WelcomeEmail; auto+query in "Daily Filter" layer; edges connect them in order']
    }
  },
  {
    id: 'scope-pivot-midway',
    title: 'Scope change mid-conversation',
    turns: [
      "Quick brain dump on the Q3 launch — we're targeting March 1.",
      "OK we have three personas: VIP patients, regulars, and lapsed. Each gets a different journey.",
      "Wait scratch that. Marketing just told us VIPs get the same journey as regulars now, just with extra sender ID. So two journeys, not three.",
      "The lapsed journey is owned by Diana Chen. She's external, contractor.",
      "We decided to delay the launch by 2 weeks — March 15, not March 1. Reason: legal review on lapsed messaging.",
      "Setup keys: lapsed sender = SP_Lapsed_Reactivate. Regular sender = SP_Standard_Promo.",
      "Architecture: each journey starts from a Daily filter automation. Regular journey = 'Promo_Daily_Refresh', lapsed = 'Lapsed_Daily_Refresh'.",
      "Anything I missed?"
    ],
    expected: {
      people: ['Diana Chen (contractor, owns lapsed journey)'],
      decisions: ['VIPs share regulars journey w/ extra sender ID (was 3 personas, now 2)', 'Delay launch from March 1 to March 15 (legal review)'],
      environment: ['SP_Lapsed_Reactivate', 'SP_Standard_Promo'],
      architecture: ['Two journeys (regulars, lapsed); two daily-refresh automations feeding each']
    }
  },
  {
    id: 'noisy-chitchat-mixed',
    title: 'Real chitchat mixed with real facts',
    turns: [
      "Morning! How are you?",
      "OK quick thing — Robert Kim joined the team yesterday, he's our new data engineer.",
      "What's the weather like in your model's training data? Lol. Anyway.",
      "Robert reports to Keyona.",
      "Don't put this in the workspace, just for context: I'm tired today.",
      "Decision yesterday: we're moving the Daily_Refresh automation from 5am to 6am because of upstream data delays.",
      "What time is it where you are? Just curious.",
      "OK that's it for now."
    ],
    expected: {
      people: ['Robert Kim (data engineer, reports to Keyona)'],
      decisions: ['Move Daily_Refresh from 5am to 6am (upstream data delays)'],
      shouldNOTcapture: ['"morning how are you"', '"I\'m tired today"', '"what time is it"']
    }
  },
  {
    id: 'architecture-heavy',
    title: 'Building out a full SFMC architecture turn-by-turn',
    turns: [
      "Let's design the Welcome Series flow from scratch.",
      "Source: a data extension called NewSubscribers_Daily, populated by an upstream sync.",
      "An automation called Welcome_Send_Daily runs at 7am, querying NewSubscribers_Daily.",
      "The query filters to subs with no welcome sent yet, and feeds a journey called WelcomeJourney.",
      "WelcomeJourney has three emails: Welcome_Email_Day0, Welcome_Email_Day3, Welcome_Email_Day7.",
      "There's also a decision split after Day3 — if they opened, route to Day7; if not, exit.",
      "Group the data extension and automation under a 'Trigger Layer'. Group the journey + emails under 'Engagement Layer'.",
      "Done — does that look right?"
    ],
    expected: {
      architecture: [
        'Nodes: NewSubscribers_Daily (deSource), Welcome_Send_Daily (automation), the SQL query (sql), WelcomeJourney (journey), three emails, decision split',
        'Edges: source → automation → query → journey → emails; decision split routes Day3 → Day7 OR exit',
        'Layers: "Trigger Layer" (DE + automation), "Engagement Layer" (journey + emails)'
      ]
    }
  },
  {
    id: 'environment-heavy',
    title: 'Recording lots of technical IDs in one session',
    turns: [
      "Let me dump the env config for the Q2 launch.",
      "Sender Profile: SP_Q2_Launch.",
      "Source DE: Subscribers_Q2.",
      "Journey ID: J_Q2_Welcome_2025.",
      "Automation: Auto_Q2_Refresh.",
      "Reply mailbox is q2-replies@example.com.",
      "And a CloudPage URL: cloud.example.com/q2-preferences",
      "That's the lot."
    ],
    expected: {
      environment: [
        'SP_Q2_Launch (sender profile)', 'Subscribers_Q2 (source DE)',
        'J_Q2_Welcome_2025 (journey id)', 'Auto_Q2_Refresh (automation)',
        'q2-replies@example.com (reply mailbox)', 'cloud.example.com/q2-preferences (CloudPage URL)'
      ],
      shouldNOTcapture: ['anything in People, Playbook, Decisions, or Architecture']
    }
  },
  {
    id: 'corrections-and-supersession',
    title: 'User keeps changing their mind — exercise corrections',
    turns: [
      "We decided to use a single template for all four segments. Owner is Alex.",
      "Actually scratch that — we're keeping the four templates. Better personalization.",
      "Let me also add: David Zernik is the new tech lead. Reports to me, the PM Sarah Lee.",
      "Wait, David already exists in the workspace? OK then just update him to tech lead, he was previously engineer.",
      "And the launch date — was Mar 1, now Mar 15.",
      "Oh and the Friday rule — we can ship on Fridays now. Legal cleared a faster review path.",
      "That's all the changes."
    ],
    expected: {
      decisions: [
        'Initial: single template (4 segments). Then SUPERSEDED by: keep four templates (better personalization).',
        'Initial: launch March 1. Then SUPERSEDED by: launch March 15.'
      ],
      people: ['David Zernik role updated to "tech lead" (was engineer); reports to Sarah Lee (PM)'],
      playbook: ['"No Friday launches" rule should be REMOVED or marked superseded — Friday launches now allowed.']
    }
  },
  {
    id: 'cross-tab-fanout',
    title: 'Single message that legitimately fans out across 4 tabs',
    turns: [
      "Big update: Susan Park is now the exec sponsor (was VP). Owner of decisions in this project. Friday no-launch rule still applies. We just decided to use SP_Susan_Test as her test sender. Action: Susan to confirm her test list by EOW.",
      "And the architecture: add a TestSendAuto automation that fires Susan's preview before each batch."
    ],
    expected: {
      people: ['Susan Park role updated to exec sponsor (was VP)'],
      decisions: ['Use SP_Susan_Test as her test sender (Susan)'],
      actions: ['Susan: confirm test list by EOW'],
      environment: ['SP_Susan_Test (sender profile)'],
      architecture: ['Add TestSendAuto (automation) that fires before each batch'],
      playbook: ['No Friday launches — already in playbook, no action needed (don\'t duplicate)']
    }
  }
]

// ── Run a single narrative end-to-end ─────────────────────────────────────

async function ensureSimWorkspace(label) {
  const SIM_USER = '00000000-0000-0000-0000-000000000001'
  const ORG_NAME = 'Delma QA Simulation Org'

  // Ensure user exists in user_notes (used as proxy for user existence)
  // Actually user must be in auth.users — we just need a uuid that won't collide.
  // The org_members + workspace_members rows are what matter for /api/op auth.

  let { data: org } = await sb.from('organizations').select('id').eq('name', ORG_NAME).maybeSingle()
  if (!org) {
    const { data: newOrg } = await sb.from('organizations')
      .insert({ name: ORG_NAME, slug: 'delma-qa-sim', created_by: SIM_USER })
      .select().single()
    org = newOrg
    await sb.from('org_members').insert({ org_id: org.id, user_id: SIM_USER, role: 'admin' }).then(() => {})
  }

  const wsName = `${label} ${new Date().toISOString().slice(0, 16).replace('T', ' ')}`
  const { data: ws } = await sb.from('workspaces')
    .insert({ name: wsName, org_id: org.id, created_by: SIM_USER }).select().single()
  await sb.from('workspace_members').insert({ workspace_id: ws.id, user_id: SIM_USER, role: 'owner' }).then(() => {})

  return { orgId: org.id, workspaceId: ws.id, userId: SIM_USER, workspaceName: wsName }
}

const CLAUDE_SYS = (toolList) => `You are Claude. After each user message, decide which TYPED OPS (if any) to call to capture facts, then reply with a short natural acknowledgement (1-2 sentences). Do NOT enumerate ops to the user.

Available ops:
${toolList}

Tabs: ${Object.keys(OPS_BY_TAB).map(f => f === 'architecture' ? 'diagram:architecture' : (['people.md','playbook.md'].includes(f) ? 'org:' : 'memory:') + f).join(', ')}

Output strict JSON ONLY:
{ "ops": [{ "tab": "<tab key>", "op": "<op>", "args": {...} }, ...], "reply": "<short reply>" }

No code fences. No prose outside the JSON.`

function buildToolList() {
  return Object.entries(OPS_BY_TAB).map(([f, ops]) => {
    const tabPrefix = f === 'architecture' ? 'diagram:' : (['people.md', 'playbook.md'].includes(f) ? 'org:' : 'memory:')
    return `  ${tabPrefix}${f}: ${ops.join(', ')}`
  }).join('\n')
}

async function runOneTurn(history) {
  const messages = []
  for (const t of history) {
    if (t.role === 'user') messages.push({ role: 'user', content: t.text })
    else messages.push({ role: 'assistant', content: t.replyOnly || t.text })
  }
  const raw = await callAnthropic(HAIKU, CLAUDE_SYS(buildToolList()), messages, 1200)
  let ops = [], reply = raw
  try {
    const j = JSON.parse(raw.replace(/^```(?:json)?\n?/, '').replace(/\n?```$/, ''))
    ops = Array.isArray(j.ops) ? j.ops : []
    reply = typeof j.reply === 'string' ? j.reply : raw
  } catch { ops = []; reply = raw.slice(0, 300) }
  return { ops, reply, raw }
}

async function applyOps(ops, ctx) {
  const out = []
  for (const o of ops) {
    if (!o.tab || !o.op) continue
    const scope = parseTabKey(o.tab, ctx)
    if (!scope) { out.push({ op: o.op, ok: false, error: 'unknown tab' }); continue }
    const t0 = Date.now()
    try {
      const r = await applyOpsToTab(sb, scope, [{ op: o.op, args: o.args || {} }])
      out.push({ op: o.op, tab: o.tab, ok: true, ms: Date.now() - t0, errors: r.errors })
    } catch (err) {
      out.push({ op: o.op, tab: o.tab, ok: false, ms: Date.now() - t0, error: err.message })
    }
  }
  return out
}

const CRITIC_SYS = `You critique a Delma narrative-test run.

Inputs:
- The narrative title + the script of user messages (ground truth)
- An "expected outcome" written by a human author (what should be in Delma after this conversation)
- The actual final structured state captured per tab
- Per-op timings + errors

Score 1-5 on:
- accuracy   (does final state match expected? penalize misses + wrong placements)
- coverage   (% of expected items present)
- correctness (right ops chosen? wrong tabs polluted? noise captured as fact?)
- timeliness (any pathological lag — outliers > 3s on a typed op?)

Return JSON ONLY:
{
  "scores": { "accuracy": <1-5>, "coverage": <1-5>, "correctness": <1-5>, "timeliness": <1-5> },
  "overall": <1-5>,
  "summary": "<2-3 sentences for a tired human at 7am>",
  "missed": [ "<expected items NOT in final state>" ],
  "wrong": [ "<things in final state that don't match the script>" ],
  "praise": [ "<things that worked well>" ]
}`

async function critique(narrative, transcript, finalState, opTimings) {
  const userMsg = `## Narrative
**${narrative.title}** (id: ${narrative.id})

### Script (user side)
${narrative.turns.map((t, i) => `T${i + 1}: ${t}`).join('\n')}

### Expected outcome (ground truth, written by author)
${JSON.stringify(narrative.expected, null, 2)}

### Actual final structured state per tab
${Object.entries(finalState).map(([k, v]) => `### ${k}\n${JSON.stringify(v, null, 2)}`).join('\n\n')}

### Op timings (ms)
${opTimings.map(t => `${t.tab}/${t.op}: ${t.ms}ms ${t.ok ? '' : '[FAIL: ' + t.error + ']'}`).join('\n')}

Critique this run.`
  const raw = await callAnthropic(SONNET, CRITIC_SYS, userMsg, 2000)
  try { return JSON.parse(raw.replace(/^```(?:json)?\n?/, '').replace(/\n?```$/, '')) }
  catch { return { overall: 0, summary: 'Critic returned unparsable JSON: ' + raw.slice(0, 200), missed: [], wrong: [], praise: [], scores: {} } }
}

export async function runNarrative(narrative) {
  console.log('[quality:nar]', narrative.id, '— starting')
  const t0 = Date.now()
  const ctx = await ensureSimWorkspace(`nar:${narrative.id}`)
  const transcript = []
  const allOpResults = []

  for (const userMsg of narrative.turns) {
    transcript.push({ role: 'user', text: userMsg })
    const { ops, reply, raw } = await runOneTurn(transcript)
    const opResults = await applyOps(ops, ctx)
    allOpResults.push(...opResults)
    transcript.push({ role: 'claude', text: reply, replyOnly: reply, ops, raw })
  }

  const [{ data: mem }, { data: org }, { data: dia }] = await Promise.all([
    sb.from('memory_notes').select('filename, structured').eq('workspace_id', ctx.workspaceId),
    sb.from('org_memory_notes').select('filename, structured').eq('org_id', ctx.orgId),
    sb.from('diagram_views').select('view_key, structured').eq('workspace_id', ctx.workspaceId)
  ])
  const finalState = {}
  for (const r of mem || []) if (r.structured) finalState['memory:' + r.filename] = r.structured
  for (const r of org || []) if (r.structured) finalState['org:' + r.filename] = r.structured
  for (const r of dia || []) if (r.structured) finalState['diagram:' + r.view_key] = r.structured

  const crit = await critique(narrative, transcript, finalState, allOpResults)
  const totalMs = Date.now() - t0

  await sb.from('quality_simulations').insert({
    workspace_id: ctx.workspaceId,
    transcript: { narrative_id: narrative.id, narrative_title: narrative.title, turns: transcript },
    ops_applied: allOpResults, final_state: finalState,
    critique: crit, total_duration_ms: totalMs,
    overall_score: crit.overall || null
  })
  console.log(`[quality:nar] ${narrative.id} — ${crit.overall}/5 in ${totalMs}ms`)
  return { narrative_id: narrative.id, score: crit.overall, totalMs }
}

// Delete QA workspaces older than N days so the test org doesn't accumulate
// hundreds of stale rows over time. Each narrative run creates a fresh ws.
export async function cleanupOldQaWorkspaces(daysOld = 3) {
  const ORG_NAME = 'Delma QA Simulation Org'
  const { data: org } = await sb.from('organizations').select('id').eq('name', ORG_NAME).maybeSingle()
  if (!org) return { deleted: 0 }
  const cutoff = new Date(Date.now() - daysOld * 86400 * 1000).toISOString()
  const { data: stale } = await sb.from('workspaces')
    .select('id').eq('org_id', org.id).lt('created_at', cutoff)
  if (!stale?.length) return { deleted: 0 }
  // Children first (cascade may not be set on every FK)
  const ids = stale.map(w => w.id)
  await sb.from('memory_notes').delete().in('workspace_id', ids)
  await sb.from('diagram_views').delete().in('workspace_id', ids)
  await sb.from('history_snapshots').delete().in('workspace_id', ids)
  await sb.from('mcp_call_logs').delete().in('workspace_id', ids)
  await sb.from('api_op_logs').delete().in('workspace_id', ids)
  await sb.from('quality_router_calls').delete().in('workspace_id', ids)
  await sb.from('workspace_members').delete().in('workspace_id', ids)
  await sb.from('workspaces').delete().in('id', ids)
  console.log('[quality:nar] cleanup —', ids.length, 'stale QA workspaces deleted')
  return { deleted: ids.length }
}

// Run all (or one specific) narrative
export async function runAllNarratives() {
  // Cleanup BEFORE so the morning view isn't polluted by yesterday's 3 sims
  // worth of dead workspaces.
  try { await cleanupOldQaWorkspaces(3) }
  catch (err) { console.warn('[quality:nar] cleanup failed (non-fatal):', err.message) }

  const out = []
  for (const n of NARRATIVES) {
    try { out.push(await runNarrative(n)) }
    catch (err) { console.error('[quality:nar] failed', n.id, err.message); out.push({ narrative_id: n.id, error: err.message }) }
  }
  return out
}

if (import.meta.url === `file://${process.argv[1]}`) {
  runAllNarratives().then(() => process.exit(0)).catch(err => { console.error(err); process.exit(1) })
}
