/**
 * chain.js — knowledge extraction chain.
 *
 * Watches Agent SDK sessions and extracts institutional knowledge.
 * Same orchestration engine as the document pipeline — dynamic pipeline
 * composition, agent authority, guiderails — different job.
 *
 * Two entry points:
 *   watchTranscript(batch) — lightweight watcher, scores for knowledge
 *   runExtraction(batch, memory) — full extraction chain when triggered
 *
 * The relay: Delma scopes → Sarah challenges → Marcus writes → James validates
 * Same handoffs, same 3D visualization, same agent personalities.
 */

import * as THREE from 'three'
import { callClaudeWithRetry, SONNET, HAIKU, DEEPSEEK_V3 } from './api.js'
import { workingTicker, setTicker } from './tickers.js'
import { createHandoffSystem } from './handoff.js'
import * as P from './prompts.js'

const CAMERA_POS = new THREE.Vector3(0.5, 3.5, -0.5)

const AGENT_COLORS = {
  delma: '#1B3A5C',
  marcus: '#2D5A3D',
  sarah: '#6B2D3D',
  james: '#4A4A4A'
}

function setStage(entries) {
  const el = document.getElementById('stage-bar')
  if (!el) return
  if (!entries) { el.classList.remove('active'); el.innerHTML = ''; return }
  const items = Array.isArray(entries) ? entries : [entries]
  el.innerHTML = items.map(({ text, color }) =>
    `<div class="stage-item" style="background:${color}">${text}</div>`
  ).join('')
  el.classList.add('active')
}

const MODEL_MAP = { deepseek: DEEPSEEK_V3, haiku: HAIKU, sonnet: SONNET }

let handoff = null
let _scene  = null

export function initChain(scene) {
  _scene  = scene
  handoff = createHandoffSystem(scene)
}

// ── Watcher: lightweight scoring ─────────────────────────────────────────────

// Watcher threshold: 0.0 = everything triggers, 1.0 = nothing triggers.
// 0.3 means "anything that's not pure noise." Delma's prompt defines
// what scores high (decisions, people, architecture) vs low (routine edits).
const WATCH_THRESHOLD = 0.3

// Lightweight scoring call — runs every ~5 messages, costs ~1s on Haiku.
// Returns { score, trigger, summary }. Only triggers extraction if score >= threshold.
export async function watchTranscript(batch, chars) {
  const { delma } = chars

  console.log('[watch] scoring batch:', batch.length, 'chars')

  const result = await callClaudeWithRetry(
    P.DELMA_WATCH,
    batch,
    null,
    HAIKU
  )

  console.log('[watch] score:', result.score, '| trigger:', result.trigger, '|', result.summary)

  if (result.score >= WATCH_THRESHOLD) {
    // Brief visual cue — Delma noticed something
    setTicker(delma.tickerEl, result.summary, delma.def.distanceOpacity)
  }

  return result
}

// ── Full extraction chain ────────────────────────────────────────────────────

// Full extraction pipeline. Same orchestration engine as the document chain:
// Delma decomposes → dynamic pipeline of Sarah/Marcus/James → memory files written.
// Ends by composing CLAUDE.md and logging the session.
export async function runExtraction(transcriptBatch, existingMemory, chars, opts = {}) {
  const { delma, marcus, sarah, james } = chars
  const agentChars = { sarah, marcus, james }
  const t0 = Date.now()
  const steps = []

  let diskHolder = delma
  const handoffTo = (to) => { handoff.send(diskHolder, to); diskHolder = to }

  console.log('[extract] starting extraction')

  marcus.faceDesk(); sarah.faceDesk(); james.faceDesk()

  // ── Step 1: Delma — decompose extraction ───────────────────────────────────
  setStage({ text: 'Delma is analyzing the session', color: AGENT_COLORS.delma })
  delma.faceCamera()
  delma.setLookTarget(CAMERA_POS)

  let stepStart = Date.now()
  const s1 = await withWorking(delma,
    ['analyzing session knowledge...', 'deciding who processes...'],
    P.DELMA_DECOMPOSE,
    {
      transcript: transcriptBatch,
      existing_memory: existingMemory
    },
    HAIKU
  )
  console.log('[extract] step 1 done —', s1.log_summary)
  await displayWorking(delma, s1.working_steps, s1.log_summary)
  steps.push(logStep(1, 'Session', 'Delma', s1.log_summary, stepStart))

  const pipeline = (s1.pipeline || []).filter(p => p.agent !== 'delma')
  const briefings = s1.briefings || {}
  const memoryTargets = s1.memory_targets || []

  if (!pipeline.length) {
    console.warn('[extract] empty pipeline — defaulting to marcus')
    pipeline.push({ agent: 'marcus', role: 'write memory captures', authority: 'shapes_the_document' })
  }

  console.log('[extract] pipeline:', pipeline.map(p => `${p.agent}(${p.authority})`).join(' → '), '| targets:', memoryTargets.join(', '))

  // ── Execute pipeline ──────────────────────────────────────────────────────
  setStage({ text: 'Delma is briefing the team', color: AGENT_COLORS.delma })

  let sarahExtractions = []
  let marcusUpdates = []
  let stepNum = 2

  for (const entry of pipeline) {
    const { agent, role, authority } = entry
    const char = agentChars[agent]
    if (!char) continue

    const capName = agent.charAt(0).toUpperCase() + agent.slice(1)
    const model = MODEL_MAP[s1[`model_${agent}`]] ?? HAIKU
    const briefing = briefings[agent] || ''

    delma.faceCharacter(char)
    delma.setLookTarget(char)
    char.faceCharacter(delma)
    char.setLookTarget(delma)

    if (briefing) {
      setTicker(delma.tickerEl, briefing, delma.def.distanceOpacity)
    }
    handoffTo(char)
    delma.faceCamera(); delma.setLookTarget(CAMERA_POS)
    char.faceDesk()

    setStage({ text: `${capName} is working`, color: AGENT_COLORS[agent] })
    stepStart = Date.now()

    // ── SARAH ─────────────────────────────────────────────────────────────
    if (agent === 'sarah') {
      const result = await withWorking(char,
        ['evaluating what matters...', 'checking against existing knowledge...'],
        P.SARAH_EXTRACT,
        {
          transcript: transcriptBatch,
          existing_memory: existingMemory,
          briefing,
          authority
        },
        model
      )
      console.log(`[extract] Sarah done —`, result.log_summary)
      await displayWorking(char, result.working_steps, result.log_summary)
      steps.push(logStep(stepNum, 'Delma', 'Sarah', result.log_summary, stepStart))

      sarahExtractions = result.extractions || []
      if (result.rejections?.length) {
        for (const r of result.rejections) {
          console.log(`  [Sarah] rejected: ${r}`)
        }
      }

    // ── MARCUS ────────────────────────────────────────────────────────────
    } else if (agent === 'marcus') {
      const result = await withWorking(char,
        ['writing memory docs...'],
        P.MARCUS_EXTRACT,
        {
          transcript: transcriptBatch,
          existing_memory: existingMemory,
          sarah_extractions: sarahExtractions,
          briefing,
          authority,
          memory_targets: memoryTargets
        },
        model
      )
      console.log(`[extract] Marcus done —`, result.log_summary)
      await displayWorking(char, result.working_steps, result.log_summary)
      steps.push(logStep(stepNum, 'Delma', 'Marcus', result.log_summary, stepStart))

      marcusUpdates = result.updates || []

    // ── JAMES ─────────────────────────────────────────────────────────────
    } else if (agent === 'james') {
      const result = await withWorking(char,
        ['validating captures...'],
        P.JAMES_EXTRACT,
        {
          transcript: transcriptBatch,
          existing_memory: existingMemory,
          proposed_updates: marcusUpdates,
          briefing,
          authority
        },
        model
      )
      console.log(`[extract] James done — approved:`, result.approved)
      await displayWorking(char, result.working_steps, result.log_summary)
      steps.push(logStep(stepNum, 'Delma', 'James', result.log_summary, stepStart))

      // Rejection cycle
      if (result.approved === false && authority === 'can_reject' && result.issues?.length) {
        setStage({ text: 'Marcus is revising', color: AGENT_COLORS.marcus })
        handoffTo(marcus)
        marcus.startWorking()
        stepStart = Date.now()
        const revised = await withWorking(marcus,
          ['fixing captures...'],
          P.MARCUS_REVISE,
          { updates: marcusUpdates, issues: result.issues, existing_memory: existingMemory },
          MODEL_MAP[s1.model_marcus] ?? HAIKU
        )
        marcus.stopWorking()
        if (revised?.updates) marcusUpdates = revised.updates
        steps.push(logStep(stepNum + 0.1, 'James', 'Marcus', revised?.log_summary || 'revised', stepStart))
      }
    }

    stepNum++
  }

  // ── Write memory files ─────────────────────────────────────────────────────
  // Marcus's updates are written to .delma/ via the REST API.
  // Then CLAUDE.md is recomposed from all memory files and copied to project root.
  // Finally, a session log entry records what was extracted.
  setStage({ text: 'Delma is saving knowledge', color: AGENT_COLORS.delma })
  handoffTo(delma)
  delma.faceCamera()
  delma.setLookTarget(CAMERA_POS)

  for (const update of marcusUpdates) {
    if (update.file && update.content) {
      console.log(`[extract] writing ${update.file}: ${update.change_summary}`)
      try {
        await fetch(`/api/memory/${update.file}`, {
          method: 'PUT',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ content: update.content })
        })
        setTicker(delma.tickerEl, `Updated ${update.file}: ${update.change_summary}`, delma.def.distanceOpacity)
      } catch (e) {
        console.error(`[extract] failed to write ${update.file}:`, e)
      }
    }
  }

  // Compose CLAUDE.md
  if (marcusUpdates.length) {
    try {
      await fetch('/api/memory/compose', { method: 'POST' })
      console.log('[extract] CLAUDE.md composed')
    } catch (e) {
      console.error('[extract] failed to compose CLAUDE.md:', e)
    }
  }

  // Log session
  const logEntry = steps.map(s => `${s.from}→${s.to}: ${s.summary}`).join('\n')
  try {
    await fetch('/api/memory/session-log', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ entry: logEntry })
    })
  } catch (e) {
    console.error('[extract] failed to log session:', e)
  }

  setStage(null)

  const duration = Math.round((Date.now() - t0) / 1000)
  console.log('[extract] complete — %ds | %d steps | %d files updated', duration, steps.length, marcusUpdates.length)
  console.table(steps)

  return {
    duration,
    steps,
    updates: marcusUpdates
  }
}

// ── Helpers ──────────────────────────────────────────────────────────────────

async function displayWorking(char, workingSteps, logSummary) {
  for (const step of workingSteps || []) {
    console.log(`  [ticker:${char.def.name}] ${step}`)
    setTicker(char.tickerEl, step, char.def.distanceOpacity)
  }
  if (logSummary) {
    console.log(`  [ticker:${char.def.name}] ${logSummary}`)
    setTicker(char.tickerEl, logSummary, char.def.distanceOpacity)
  }
}

function logStep(step, from, to, summary, startMs) {
  return {
    step,
    from,
    to,
    summary: summary || '—',
    time: ((Date.now() - startMs) / 1000).toFixed(1) + 's'
  }
}

async function withWorking(char, loadingMessages, systemPrompt, userMessage, model, maxTokens) {
  model = model || HAIKU
  console.log(`  [api] ${char.def.name} → ${model.split('-').slice(-2).join('-')}`)
  char.startWorking()

  const signal = { done: false }
  const tickerPromise = workingTicker(char.tickerEl, loadingMessages, char.def.distanceOpacity, signal)

  let result

  try {
    result = await callClaudeWithRetry(
      systemPrompt,
      userMessage,
      () => setTicker(char.tickerEl, 'retrying...', char.def.distanceOpacity),
      model,
      maxTokens
    )
  } catch (err) {
    signal.done = true
    char.stopWorking()
    await tickerPromise
    throw err
  }

  console.log(`  [api:response] ${char.def.name}`, result)

  signal.done = true
  char.stopWorking()
  await tickerPromise

  return result
}
