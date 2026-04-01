/**
 * chain.js — knowledge extraction chain.
 *
 * Watches Agent SDK sessions and extracts institutional knowledge.
 * Uses three orchestration primitives (from orchestration.js):
 *   EventBus     — agents publish observations, others subscribe
 *   SharedMemory — all agents see everything produced so far
 *   TaskQueue    — dependency-aware parallel execution
 *
 * Two entry points:
 *   watchTranscript(batch) — lightweight watcher, scores for knowledge
 *   runExtraction(batch, memory) — full extraction chain
 *
 * The extraction pipeline:
 *   1. Delma decomposes → decides who works, builds task graph
 *   2. Tasks execute via TaskQueue — independent tasks run in parallel,
 *      dependent tasks wait. James always waits for all writes.
 *   3. Agents communicate via EventBus — Sarah's challenges reach James
 *      even when Marcus is between them in the pipeline.
 *   4. SharedMemory accumulates — every agent sees everything.
 *   5. Memory files written, CLAUDE.md composed, session logged.
 */

import * as THREE from 'three'
import { callClaudeWithRetry, SONNET, HAIKU, DEEPSEEK_V3, GPT4O, GPT4O_MINI } from './api.js'
import { workingTicker, setTicker } from './tickers.js'
import { createHandoffSystem } from './handoff.js'
import { EventBus, SharedMemory, TaskQueue, AgentTools } from './orchestration.js'
import { runSingleNode } from './subagents.js'
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
  if (!entries) { el.classList.remove('active'); el.textContent = ''; return }
  const items = Array.isArray(entries) ? entries : [entries]
  el.textContent = ''
  for (const { text, color, failed } of items) {
    const div = document.createElement('div')
    div.className = 'stage-item' + (failed ? ' failed' : '')
    div.style.background = color
    div.textContent = text
    el.appendChild(div)
  }
  el.classList.add('active')
}

const MODEL_MAP = { deepseek: DEEPSEEK_V3, haiku: HAIKU, sonnet: SONNET, gpt4o: GPT4O, 'gpt4o-mini': GPT4O_MINI }

let handoff = null
let _scene  = null

// Failed writes queued for retry on next extraction
let _failedWrites = []

// Track active stage entries — parallel tasks add/remove themselves
let _activeStages = []

function addStage(id, text, color, failed = false) {
  _activeStages = _activeStages.filter(s => s.id !== id)
  _activeStages.push({ id, text, color, failed })
  setStage(_activeStages)
}

function removeStage(id) {
  _activeStages = _activeStages.filter(s => s.id !== id)
  if (_activeStages.length) {
    setStage(_activeStages)
  } else {
    setStage(null)
  }
}

function clearStages() {
  _activeStages = []
  setStage(null)
}

export function initChain(scene) {
  _scene  = scene
  handoff = createHandoffSystem(scene)
}

// ── Watcher: lightweight scoring ─────────────────────────────────────────────

const WATCH_THRESHOLD = 0.3

export async function watchTranscript(batch, chars) {
  const { delma } = chars
  console.log('[watch] scoring batch:', batch.length, 'chars')

  const result = await callClaudeWithRetry(P.DELMA_WATCH, batch, null, HAIKU)
  console.log('[watch] score:', result.score, '| trigger:', result.trigger, '|', result.summary)

  if (result.score >= WATCH_THRESHOLD) {
    setTicker(delma.tickerEl, result.summary, delma.def.distanceOpacity)
  }

  return result
}

// ── Full extraction chain ────────────────────────────────────────────────────

export async function runExtraction(transcriptBatch, existingMemory, chars, opts = {}) {
  const { delma, marcus, sarah, james } = chars
  const agentChars = { sarah, marcus, james }
  const t0 = Date.now()
  const steps = []
  const onStep = opts.onExtractionStep || null  // callback to show activity in UI

  // Create orchestration primitives for this extraction
  const bus = new EventBus()
  const mem = new SharedMemory()
  const queue = new TaskQueue({ concurrency: 2 })  // max 2 parallel API calls
  const tools = new AgentTools(opts.projectDir || null)

  // Seed shared memory with input context + session history
  mem.set('transcript', transcriptBatch, 'system')
  mem.set('existing_memory', existingMemory, 'system')
  mem.set('session_log', existingMemory['session-log.md'] || '', 'system')
  mem.set('sarah_history', existingMemory['sarah-history.md'] || '', 'system')
  mem.set('marcus_history', existingMemory['marcus-history.md'] || '', 'system')
  mem.set('james_history', existingMemory['james-history.md'] || '', 'system')

  let diskHolder = delma
  const handoffTo = (to) => { handoff.send(diskHolder, to); diskHolder = to }

  console.log('[extract] starting extraction')
  marcus.faceDesk(); sarah.faceDesk(); james.faceDesk()

  // ── Step 1: Delma decomposes ───────────────────────────────────────────────
  clearStages()
  addStage('delma', 'Delma is analyzing the session', AGENT_COLORS.delma)
  delma.faceCamera()
  delma.setLookTarget(CAMERA_POS)

  let stepStart = Date.now()
  const s1 = await withWorking(delma,
    ['analyzing session knowledge...', 'deciding who processes...'],
    P.DELMA_DECOMPOSE,
    { transcript: transcriptBatch, existing_memory: existingMemory },
    HAIKU
  )
  console.log('[extract] step 1 done —', s1.log_summary)
  await displayWorking(delma, s1.working_steps, s1.log_summary, onStep)
  steps.push(logStep(1, 'Session', 'Delma', s1.log_summary, stepStart))

  mem.set('decomposition', s1, 'delma')
  bus.publish('decomposition', 'delma', 'coordinator', s1)

  const pipeline = (s1.pipeline || []).filter(p => p.agent !== 'delma')
  const briefings = s1.briefings || {}
  const memoryTargets = s1.memory_targets || []

  if (!pipeline.length) {
    pipeline.push({ agent: 'marcus', role: 'write memory captures', authority: 'shapes_the_document' })
  }

  console.log('[extract] pipeline:', pipeline.map(p => `${p.agent}(${p.authority})`).join(' → '), '| targets:', memoryTargets.join(', '))

  // ── Build task graph from pipeline ─────────────────────────────────────────
  // Delma's pipeline is an ordered list, but we convert it to a dependency graph:
  // - Sarah tasks have no dependencies (they run first)
  // - Marcus tasks depend on Sarah (if she's in the pipeline)
  // - If Delma specified multiple memory targets and Marcus is in the pipeline,
  //   we create one Marcus task per target — they run in parallel
  // - James depends on ALL Marcus tasks

  addStage('delma', 'Delma is briefing the team', AGENT_COLORS.delma)

  const sarahInPipeline = pipeline.some(p => p.agent === 'sarah')
  const marcusInPipeline = pipeline.some(p => p.agent === 'marcus')
  const jamesInPipeline = pipeline.some(p => p.agent === 'james')
  const sarahEntry = pipeline.find(p => p.agent === 'sarah')
  const marcusEntry = pipeline.find(p => p.agent === 'marcus')
  const jamesEntry = pipeline.find(p => p.agent === 'james')

  // Sarah task
  if (sarahInPipeline) {
    queue.add({
      id: 'sarah',
      agent: 'sarah',
      dependsOn: [],
      run: async () => {
        const char = agentChars.sarah
        const model = MODEL_MAP[s1.model_sarah] ?? HAIKU
        const briefing = briefings.sarah || ''

        delma.faceCharacter(char); delma.setLookTarget(char)
        char.faceCharacter(delma); char.setLookTarget(delma)
        if (briefing) setTicker(delma.tickerEl, briefing, delma.def.distanceOpacity)
        handoffTo(char)
        delma.faceCamera(); delma.setLookTarget(CAMERA_POS)
        char.faceDesk()

        removeStage('delma')
        addStage('sarah', 'Sarah is evaluating', AGENT_COLORS.sarah)
        const start = Date.now()
        const result = await withWorking(char,
          ['evaluating what matters...', 'checking against existing knowledge...'],
          P.SARAH_EXTRACT + tools.getToolDescriptions('sarah'),
          { transcript: mem.get('transcript'), existing_memory: mem.get('existing_memory'), shared_context: mem.getSummary(), my_history: mem.get('sarah_history'), briefing, authority: sarahEntry.authority },
          model
        )
        await displayWorking(char, result.working_steps, result.log_summary, onStep)
        steps.push(logStep(2, 'Delma', 'Sarah', result.log_summary, start))
        removeStage('sarah')

        // Write to shared memory and publish
        mem.set('extractions', result.extractions || [], 'sarah')
        mem.set('rejections', result.rejections || [], 'sarah')
        bus.publish('extraction', 'sarah', sarahEntry.authority, result)

        if (result.rejections?.length) {
          for (const r of result.rejections) {
            bus.publish('rejection', 'sarah', sarahEntry.authority, r)
          }
        }

        return result
      }
    })
  }

  // Marcus tasks — one per memory target for parallel execution, or one if single target
  // Multiple targets spawn sub-agent figures (mini Marcus) for each parallel file update.
  const marcusTaskIds = []
  if (marcusInPipeline) {
    const targets = memoryTargets.length > 1 ? memoryTargets : ['all']
    const marcusDeps = sarahInPipeline ? ['sarah'] : []
    const isParallel = targets.length > 1

    for (let i = 0; i < targets.length; i++) {
      const target = targets[i]
      const taskId = isParallel ? `marcus-${target.replace('.md', '')}` : 'marcus'
      marcusTaskIds.push(taskId)

      queue.add({
        id: taskId,
        agent: 'marcus',
        dependsOn: marcusDeps,
        run: async () => {
          const char = agentChars.marcus
          const model = MODEL_MAP[s1.model_marcus] ?? HAIKU
          const briefing = briefings.marcus || ''

          // First task does the handoff animation
          if (i === 0) {
            delma.faceCharacter(char); delma.setLookTarget(char)
            char.faceCharacter(delma); char.setLookTarget(delma)
            if (briefing) setTicker(delma.tickerEl, briefing, delma.def.distanceOpacity)
            handoffTo(char)
            delma.faceCamera(); delma.setLookTarget(CAMERA_POS)
            char.faceDesk()
          }

          const stageText = isParallel ? `Marcus is writing ${target}` : 'Marcus is writing'
          addStage(taskId, stageText, AGENT_COLORS.marcus)
          const start = Date.now()
          const targetFilter = target === 'all' ? memoryTargets : [target]

          let result
          if (isParallel) {
            // Parallel targets: spawn a sub-agent mini figure per file
            char.startWorking()
            result = await runSingleNode(_scene, char, i, {
              label: target,
              systemPrompt: P.MARCUS_EXTRACT + tools.getToolDescriptions('marcus'),
              userMessage: {
                transcript: mem.get('transcript'),
                existing_memory: mem.get('existing_memory'),
                shared_context: mem.getSummary(),
                sarah_extractions: mem.get('extractions') || [],
                my_history: mem.get('marcus_history'),
                briefing,
                authority: marcusEntry.authority,
                memory_targets: targetFilter
              },
              model
            })
            // runSingleNode returns the raw result or null on failure
            if (!result) {
              char.stopWorking()
              removeStage(taskId)
              throw new Error(`Marcus failed to write ${target}`)
            }
            char.stopWorking()
          } else {
            // Single target: Marcus works directly (no sub-agent figure)
            result = await withWorking(char,
              ['writing memory docs...'],
              P.MARCUS_EXTRACT + tools.getToolDescriptions('marcus'),
              {
                transcript: mem.get('transcript'),
                existing_memory: mem.get('existing_memory'),
                shared_context: mem.getSummary(),
                sarah_extractions: mem.get('extractions') || [],
                my_history: mem.get('marcus_history'),
                briefing,
                authority: marcusEntry.authority,
                memory_targets: targetFilter
              },
              model
            )
            await displayWorking(char, result.working_steps, result.log_summary, onStep)
          }

          steps.push(logStep(3, 'Delma', 'Marcus', result.log_summary || `wrote ${target}`, start))
          removeStage(taskId)

          // Write to shared memory and publish
          const updates = result.updates || []
          const existingUpdates = mem.get('updates') || []
          mem.set('updates', [...existingUpdates, ...updates], 'marcus')
          bus.publish('update', 'marcus', marcusEntry.authority, updates)

          return result
        }
      })
    }
  }

  // James task — depends on ALL Marcus tasks
  if (jamesInPipeline) {
    queue.add({
      id: 'james',
      agent: 'james',
      dependsOn: marcusTaskIds.length ? marcusTaskIds : (sarahInPipeline ? ['sarah'] : []),
      run: async () => {
        const char = agentChars.james
        const model = MODEL_MAP[s1.model_james] ?? HAIKU
        const briefing = briefings.james || ''

        delma.faceCharacter(char); delma.setLookTarget(char)
        char.faceCharacter(delma); char.setLookTarget(delma)
        if (briefing) setTicker(delma.tickerEl, briefing, delma.def.distanceOpacity)
        handoffTo(char)
        delma.faceCamera(); delma.setLookTarget(CAMERA_POS)
        char.faceDesk()

        addStage('james', 'James is validating', AGENT_COLORS.james)
        const start = Date.now()

        // James sees everything — shared memory has the full context
        const result = await withWorking(char,
          ['validating captures...'],
          P.JAMES_EXTRACT + tools.getToolDescriptions('james'),
          {
            transcript: mem.get('transcript'),
            existing_memory: mem.get('existing_memory'),
            shared_context: mem.getSummary(),
            proposed_updates: mem.get('updates') || [],
            my_history: mem.get('james_history'),
            briefing,
            authority: jamesEntry.authority
          },
          model
        )
        await displayWorking(char, result.working_steps, result.log_summary, onStep)
        steps.push(logStep(4, 'Delma', 'James', result.log_summary, start))

        mem.set('validation', result, 'james')
        bus.publish('validation', 'james', jamesEntry.authority, result)

        // Rejection cycle
        if (result.approved === false && jamesEntry.authority === 'can_reject' && result.issues?.length) {
          bus.publish('rejection', 'james', 'can_reject', result.issues)

          addStage('marcus-revise', 'Marcus is revising', AGENT_COLORS.marcus)
          handoffTo(marcus)
          marcus.startWorking()
          const revStart = Date.now()
          const revised = await withWorking(marcus,
            ['fixing captures...'],
            P.MARCUS_REVISE,
            { updates: mem.get('updates') || [], issues: result.issues, existing_memory: existingMemory },
            MODEL_MAP[s1.model_marcus] ?? HAIKU
          )
          marcus.stopWorking()

          if (revised?.updates) {
            mem.set('updates', revised.updates, 'marcus')
            bus.publish('revision', 'marcus', 'supports', revised.updates)
          }
          steps.push(logStep(4.1, 'James', 'Marcus', revised?.log_summary || 'revised', revStart))
          removeStage('marcus-revise')
        }

        removeStage('james')
        return result
      }
    })
  }

  // ── Execute task graph ─────────────────────────────────────────────────────
  console.log('[extract] task graph:', [...queue._tasks.keys()].join(', '))

  await queue.run(
    // onTaskStart
    (task) => console.log(`[extract] starting ${task.id}`),
    // onTaskDone — show failure in stage bar if task failed or cascade-failed
    (task, result) => {
      if (result?.error) {
        const capName = (task.agent || task.id).charAt(0).toUpperCase() + (task.agent || task.id).slice(1)
        const isCascade = result.error.startsWith('Cascade failure')
        const text = isCascade
          ? `${capName} skipped — upstream failed`
          : `${capName} failed`
        addStage(`fail-${task.id}`, text, '#991b1b', true)
        console.warn(`[extract] ${task.id} failed:`, result.error)
        // Auto-remove failed stage after 3 seconds
        setTimeout(() => removeStage(`fail-${task.id}`), 3000)
      } else {
        console.log(`[extract] completed ${task.id}`)
      }
    }
  )

  // ── Write memory files ─────────────────────────────────────────────────────
  addStage('delma-save', 'Delma is saving knowledge', AGENT_COLORS.delma)
  handoffTo(delma)
  delma.faceCamera()
  delma.setLookTarget(CAMERA_POS)

  // ── Retry any failed writes from previous extractions ─────────────────────
  if (_failedWrites.length) {
    console.log(`[extract] retrying ${_failedWrites.length} failed writes from previous extraction`)
    const retrying = [..._failedWrites]
    _failedWrites = []
    for (const fw of retrying) {
      try {
        const res = await fetch(fw.url, fw.opts)
        if (!res.ok) throw new Error(`${res.status}`)
        console.log(`[extract] retry succeeded: ${fw.label}`)
      } catch (e) {
        console.warn(`[extract] retry failed again: ${fw.label}`)
        _failedWrites.push(fw)  // re-queue for next time
      }
    }
  }

  // ── Write memory files ───────────────────────────────────────────────────
  const marcusUpdates = mem.get('updates') || []
  let writeFailures = 0

  for (const update of marcusUpdates) {
    if (update.file && update.content) {
      console.log(`[extract] writing ${update.file}: ${update.change_summary}`)
      try {
        const res = await fetch(`/api/memory/${update.file}`, {
          method: 'PUT',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ content: update.content })
        })
        if (!res.ok) throw new Error(`${res.status} ${res.statusText}`)
        setTicker(delma.tickerEl, `Updated ${update.file}: ${update.change_summary}`, delma.def.distanceOpacity)
      } catch (e) {
        console.error(`[extract] failed to write ${update.file}:`, e)
        writeFailures++
        _failedWrites.push({
          label: `memory/${update.file}`,
          url: `/api/memory/${update.file}`,
          opts: { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ content: update.content }) }
        })
      }
    }
  }

  // Compose CLAUDE.md (only if all writes succeeded — don't compose from partial state)
  if (marcusUpdates.length && writeFailures === 0) {
    try {
      const res = await fetch('/api/memory/compose', { method: 'POST' })
      if (!res.ok) throw new Error(`${res.status} ${res.statusText}`)
      console.log('[extract] CLAUDE.md composed')
    } catch (e) {
      console.error('[extract] failed to compose CLAUDE.md:', e)
    }
  } else if (writeFailures > 0) {
    console.warn(`[extract] skipping CLAUDE.md compose — ${writeFailures} write(s) failed`)
    if (onStep) onStep('Delma', `⚠ ${writeFailures} memory write(s) failed — will retry next extraction`)
  }

  // Log session
  const logEntry = steps.map(s => `${s.from}→${s.to}: ${s.summary}`).join('\n')
  try {
    const res = await fetch('/api/memory/session-log', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ entry: logEntry })
    })
    if (!res.ok) throw new Error(`${res.status} ${res.statusText}`)
  } catch (e) {
    console.error('[extract] failed to log session:', e)
    _failedWrites.push({
      label: 'session-log',
      url: '/api/memory/session-log',
      opts: { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ entry: logEntry }) }
    })
  }

  // Write per-agent history
  const timestamp = new Date().toISOString()
  const agentHistories = {
    sarah: steps.filter(s => s.to === 'Sarah').map(s => s.summary),
    marcus: steps.filter(s => s.to === 'Marcus').map(s => s.summary),
    james: steps.filter(s => s.to === 'James').map(s => s.summary)
  }
  for (const [agent, summaries] of Object.entries(agentHistories)) {
    if (!summaries.length) continue
    const entry = `\n## ${timestamp}\n${summaries.join('\n')}\n`
    let existingHistory = ''
    try {
      const readRes = await fetch(`/api/memory/${agent}-history.md`)
      existingHistory = readRes.ok ? (await readRes.json()).content || '' : ''
      const res = await fetch(`/api/memory/${agent}-history.md`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ content: existingHistory + entry })
      })
      if (!res.ok) throw new Error(`${res.status}`)
    } catch (e) {
      console.error(`[extract] failed to write ${agent} history:`, e)
      _failedWrites.push({
        label: `${agent}-history`,
        url: `/api/memory/${agent}-history.md`,
        opts: { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ content: existingHistory + entry }) }
      })
      if (onStep) onStep('Delma', `⚠ Failed to save ${agent}'s history — will retry`)
    }
  }

  clearStages()

  const duration = Math.round((Date.now() - t0) / 1000)
  const busMessages = bus.query().length
  console.log('[extract] complete — %ds | %d steps | %d files updated | %d bus messages', duration, steps.length, marcusUpdates.length, busMessages)
  console.table(steps)

  return {
    duration,
    steps,
    updates: marcusUpdates,
    busHistory: bus.query(),
    memoryLog: mem.getLog()
  }
}

// ── Helpers ──────────────────────────────────────────────────────────────────

async function displayWorking(char, workingSteps, logSummary, onStep) {
  for (const step of workingSteps || []) {
    console.log(`  [ticker:${char.def.name}] ${step}`)
    setTicker(char.tickerEl, step, char.def.distanceOpacity)
    if (onStep) onStep(char.def.name, step)
  }
  if (logSummary) {
    console.log(`  [ticker:${char.def.name}] ${logSummary}`)
    setTicker(char.tickerEl, logSummary, char.def.distanceOpacity)
    if (onStep) onStep(char.def.name, logSummary)
  }
}

function logStep(step, from, to, summary, startMs) {
  return { step, from, to, summary: summary || '—', time: ((Date.now() - startMs) / 1000).toFixed(1) + 's' }
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
      systemPrompt, userMessage,
      () => setTicker(char.tickerEl, 'retrying...', char.def.distanceOpacity),
      model, maxTokens
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
