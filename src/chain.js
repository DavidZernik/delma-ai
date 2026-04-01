/**
 * chain.js — document-as-artifact agent chain.
 *
 * The chain builds ONE document from start to finish.
 * Each agent receives the current document and returns a better version.
 *
 * Two tracks:
 *   Display track — working_steps, log_summary → tickers
 *   Content track — document → flows through every step, delivered at end
 *
 * Delma composes a dynamic pipeline per request — an ordered list of agents
 * with roles and authority levels. The chain executes whatever she decides,
 * constrained by guiderails baked into her prompt.
 *
 * Overlays:
 *   Web search       → runs after Delma scopes, before pipeline starts
 *   User checkpoint  → after Delma scopes, user sees the plan and can adjust
 *   Premise challenge → if Sarah flags a flawed premise, pipeline pauses
 *   James rejection  → Marcus revise + James re-check, one cycle max
 */

import * as THREE from 'three'
import { callClaudeWithRetry, callSearch, SONNET, HAIKU, DEEPSEEK_V3 } from './api.js'
import { showLine, workingTicker, iconFor, sleep, setTicker } from './tickers.js'
import { createHandoffSystem } from './handoff.js'
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
  if (!entries) { el.classList.remove('active'); el.innerHTML = ''; return }
  const items = Array.isArray(entries) ? entries : [entries]
  el.innerHTML = items.map(({ text, color }) =>
    `<div class="stage-item" style="background:${color}">${text}</div>`
  ).join('')
  el.classList.add('active')
}

// Cost mode: 'budget' routes agents to cheaper models by default.
const COST_MODE = 'budget'
const ROUTING_POLICY = {
  budget:  'ROUTING POLICY: Default all agents to deepseek unless the task genuinely requires human-level judgment. Prefer cheaper models.',
  quality: 'ROUTING POLICY: Prefer haiku for production tasks, sonnet for judgment-heavy tasks. Use deepseek for simple drafting.'
}

const MODEL_MAP = { deepseek: DEEPSEEK_V3, haiku: HAIKU, sonnet: SONNET }

let handoff = null
let _scene  = null

export function initChain(scene) {
  _scene  = scene
  handoff = createHandoffSystem(scene)
}

// ── Main entry ───────────────────────────────────────────────────────────────

export async function runChain(query, chars, opts = {}) {
  const { delma, marcus, sarah, james } = chars
  const agentChars = { sarah, marcus, james }
  const t0 = Date.now()
  const steps = []

  // Disk always knows who holds it
  let diskHolder = delma
  const handoffTo = async (to) => { await handoff.send(diskHolder, to); diskHolder = to }

  console.log('[chain] starting:', query)

  // All characters face their desks at start
  marcus.faceDesk(); sarah.faceDesk(); james.faceDesk()

  // ── Step 1: Delma — decompose ──────────────────────────────────────────────
  setStage({ text: 'Delma is scoping the request', color: AGENT_COLORS.delma })
  delma.faceCamera()
  delma.setLookTarget(CAMERA_POS)

  console.log('[chain] step 1 — Delma decompose')
  let stepStart = Date.now()
  const delmaPrompt = ROUTING_POLICY[COST_MODE] + '\n\n' + P.DELMA_DECOMPOSE
  const s1 = await withWorking(delma,
    ['scoping the request...', 'mapping the task...', 'deciding who works...'],
    delmaPrompt, query, HAIKU
  )
  console.log('[chain] step 1 done — complexity:', s1.complexity, '|', s1.log_summary)
  await displayWorking(delma, s1.working_steps, s1.log_summary)
  steps.push(logStep(1, 'User', 'Delma', s1.log_summary, stepStart))

  // Filter Delma out of pipeline (she coordinates, doesn't execute)
  const pipeline = (s1.pipeline || []).filter(p => p.agent !== 'delma')
  const lengthSignal = s1.task_spec?.length || 'moderate'
  const sectionCount = s1.task_spec?.sections || 1
  const briefings = s1.briefings || {}

  // Guard: pipeline must have at least one agent
  if (!pipeline.length) {
    console.warn('[chain] empty pipeline after filtering — defaulting to marcus')
    pipeline.push({ agent: 'marcus', role: 'produce the deliverable', authority: 'shapes_the_document' })
  }

  console.log('[chain] pipeline:', pipeline.map(p => `${p.agent}(${p.authority})`).join(' → '), '| length:', lengthSignal, '| sections:', sectionCount)

  // Show plan to user
  if (s1.plan_summary) {
    await showLine(delma.tickerEl, s1.plan_summary, 1500, delma.def.distanceOpacity)
  }

  // ── Step 1.5: Web search (if Delma flagged it) ────────────────────────────
  let searchContext = ''
  if (s1.needs_search && s1.search_queries?.length) {
    console.log('[chain] step 1.5 — web search:', s1.search_queries)
    setStage({ text: 'Delma is searching the web', color: AGENT_COLORS.delma })
    delma.startWorking()
    await showLine(delma.tickerEl, 'searching the web...', 1200, delma.def.distanceOpacity)

    const chunks = []
    for (const q of s1.search_queries.slice(0, 3)) {
      try {
        const { context } = await callSearch(q, 5)
        if (context) chunks.push(context)
        console.log(`  [search] "${q}" → ${context?.length ?? 0} chars`)
      } catch (e) {
        console.warn(`  [search] "${q}" failed:`, e.message)
      }
    }

    if (chunks.length) {
      searchContext = chunks.join('\n\n')
      await showLine(delma.tickerEl, `web: ${chunks.length} queries complete`, 1200, delma.def.distanceOpacity)
    }
    delma.stopWorking()
  }

  // ── Execute pipeline ──────────────────────────────────────────────────────
  // Stage stays active from Delma scoping → first agent picks it up in the loop
  setStage({ text: 'Delma is briefing the team', color: AGENT_COLORS.delma })

  let document = ''
  let deliveryLines = []
  let sarahContext = {}  // subjects, section_briefs, shared_context, recommendation
  let stepNum = 2

  for (const entry of pipeline) {
    const { agent, role, authority } = entry
    const char = agentChars[agent]
    if (!char) { console.warn('[chain] unknown agent:', agent); continue }

    const capName = agent.charAt(0).toUpperCase() + agent.slice(1)
    const model = MODEL_MAP[s1[`model_${agent}`]] ?? (agent === 'james' ? HAIKU : DEEPSEEK_V3)
    const briefing = briefings[agent] || ''

    // ── Handoff animation ─────────────────────────────────────────────────
    delma.faceCharacter(char)
    delma.setLookTarget(char)
    char.faceCharacter(delma)
    char.setLookTarget(delma)

    if (briefing) {
      console.log(`  [ticker:Delma] briefing ${agent}:`, briefing)
      await showLine(delma.tickerEl, briefing, 1000, delma.def.distanceOpacity)
    }
    await handoffTo(char)
    delma.faceCamera(); delma.setLookTarget(CAMERA_POS)
    char.faceDesk()

    setStage({ text: `${capName} is working`, color: AGENT_COLORS[agent] })
    stepStart = Date.now()

    // ── SARAH ───────────────────────────────────────────────────────────────
    if (agent === 'sarah') {
      const marcusDownstream = pipeline.some(p => p.agent === 'marcus')
      console.log(`[chain] step ${stepNum} — Sarah (${authority}), marcus_downstream: ${marcusDownstream}`)
      const result = await withWorking(char,
        ['reading the situation...', 'forming a position...'],
        P.SARAH_WORK,
        {
          task_spec: s1.task_spec,
          original_query: query,
          briefing,
          authority,
          shared_context: searchContext,
          marcus_downstream: marcusDownstream
        },
        model
      )
      console.log(`[chain] step ${stepNum} done —`, result.log_summary)
      await displayWorking(char, result.working_steps, result.log_summary)
      steps.push(logStep(stepNum, 'Delma', 'Sarah', result.log_summary, stepStart))

      // Premise challenge — pause pipeline, surface to user
      if (result.premise_challenge && result.premise_challenge !== 'null' && opts.onCheckpoint) {
        console.log('[chain] premise challenge:', result.premise_challenge)
        setStage({ text: 'Sarah is challenging the premise', color: AGENT_COLORS.sarah })
        await showLine(char.tickerEl, result.premise_challenge, 2000, char.def.distanceOpacity)
        const userResponse = await opts.onCheckpoint(result.premise_challenge)
        if (userResponse) {
          console.log('[chain] user responded to premise challenge:', userResponse)
          // User overrode — continue with their direction
        }
        // Either way, continue pipeline with Sarah's output
      }

      // Store Sarah's context for Marcus downstream
      sarahContext = {
        subjects: result.subjects || [],
        section_briefs: result.section_briefs || [],
        shared_context: result.shared_context || '',
        recommendation: result.recommendation || ''
      }

      // If Sarah produced a solo document, capture it
      if (result.document) {
        document = result.document
        deliveryLines = result.delivery_lines || []
      }

    // ── MARCUS ──────────────────────────────────────────────────────────────
    } else if (agent === 'marcus') {
      console.log(`[chain] step ${stepNum} — Marcus (${authority}), sections: ${sectionCount}`)

      if (sectionCount <= 1 || (sarahContext.subjects?.length || 0) <= 1) {
        // ── Solo / single section: Marcus produces the whole thing ──────────
        const subjects = sarahContext.subjects?.length ? sarahContext.subjects : [s1.task_spec?.deliverable || 'response']
        const result = await withWorking(char,
          ['writing...'],
          P.MARCUS_WORK,
          {
            task_spec: s1.task_spec,
            original_query: query,
            briefing,
            authority,
            shared_context: searchContext
              ? `${sarahContext.shared_context || ''}\n\nWEB RESEARCH:\n${searchContext}`.trim()
              : sarahContext.shared_context || '',
            sarah_recommendation: sarahContext.recommendation || '',
            section_briefs: sarahContext.section_briefs || []
          },
          model
        )
        console.log(`[chain] step ${stepNum} done —`, result.log_summary)
        await displayWorking(char, result.working_steps, result.log_summary)
        steps.push(logStep(stepNum, 'Delma', 'Marcus', result.log_summary, stepStart))
        document = result.document || ''
        deliveryLines = result.delivery_lines || []

      } else {
        // ── Multi-section: parallel sub-agents ─────────────────────────────
        const subjects = sarahContext.subjects.slice(0, 3)
        const sharedCtx = searchContext
          ? `${sarahContext.shared_context || ''}\n\nWEB RESEARCH:\n${searchContext}`.trim()
          : sarahContext.shared_context || ''

        char.startWorking()
        setStage({ text: 'Marcus is writing sections', color: AGENT_COLORS.marcus })

        const sectionResults = await Promise.all(
          subjects.map((subject, idx) => {
            const sectionBrief = sarahContext.section_briefs?.find(b => b.section === subject)
            return runSingleNode(_scene, char, idx, {
              label: subject,
              systemPrompt: P.MARCUS_SECTION,
              userMessage: {
                task_spec: s1.task_spec,
                shared_context: sharedCtx,
                all_sections: subjects,
                section_title: subject,
                section_brief: sectionBrief || { section: subject, marcus_task: briefing },
                sarah_recommendation: sarahContext.recommendation || '',
                length: lengthSignal
              },
              model
            })
          })
        )
        char.stopWorking()

        const validSections = sectionResults.filter(Boolean)
        console.log(`[chain] step ${stepNum} — Marcus wrote ${validSections.length}/${subjects.length} sections`)

        // Assembly step only for 3+ sections
        if (validSections.length >= 3) {
          setStage({ text: 'Marcus is assembling', color: AGENT_COLORS.marcus })
          char.startWorking()
          const assemblyResult = await withWorking(char,
            ['assembling...'],
            P.MARCUS_ASSEMBLE,
            {
              task_spec: { objective: s1.task_spec.objective, deliverable: s1.task_spec.deliverable },
              shared_context: sharedCtx,
              sections: validSections.map(s => ({ section_title: s.section_title, content: s.content }))
            },
            model, 12000
          )
          char.stopWorking()
          document = assemblyResult?.document
            || validSections.map(s => `## ${s.section_title}\n\n${s.content}`).join('\n\n')

          if (assemblyResult?.coherence_fixes?.length) {
            for (const fix of assemblyResult.coherence_fixes) {
              await showLine(char.tickerEl, `↳ ${fix}`, 1000, char.def.distanceOpacity)
            }
          }
        } else {
          // 1-2 sections: just concatenate, no assembly call
          document = validSections.map(s => `## ${s.section_title}\n\n${s.content}`).join('\n\n')
        }

        await displayWorking(char, [], `${validSections.length} sections written`)
        steps.push(logStep(stepNum, 'Delma', 'Marcus', `${validSections.length} sections produced`, stepStart))
      }

    // ── JAMES ───────────────────────────────────────────────────────────────
    } else if (agent === 'james') {
      console.log(`[chain] step ${stepNum} — James (${authority})`)
      const result = await withWorking(char,
        ['checking the document...'],
        P.JAMES_CHECK,
        {
          document,
          original_query: query,
          briefing,
          authority,
          task_spec: s1.task_spec
        },
        model
      )
      console.log(`[chain] step ${stepNum} done — approved:`, result.approved, '|', result.log_summary)
      await displayWorking(char, result.working_steps, result.log_summary)

      if (result.issues?.length) {
        for (const issue of result.issues) {
          console.log(`  [ticker:James] ⚠ ${issue}`)
          await showLine(char.tickerEl, `⚠ ${issue}`, 2000, char.def.distanceOpacity)
          await sleep(60)
        }
      }
      steps.push(logStep(stepNum, 'Delma', 'James', result.log_summary, stepStart))

      // Rejection cycle (only if authority allows)
      if (result.approved === false && authority === 'can_reject' && result.issues?.length) {
        console.log('[chain] James rejected — Marcus revision cycle')

        // Marcus revises
        setStage({ text: 'Marcus is revising', color: AGENT_COLORS.marcus })
        await handoffTo(marcus)
        marcus.startWorking()
        stepStart = Date.now()
        const revised = await withWorking(marcus,
          ['addressing feedback...'],
          P.MARCUS_REVISE,
          { document, issues: result.issues },
          MODEL_MAP[s1.model_marcus] ?? DEEPSEEK_V3
        )
        marcus.stopWorking()
        if (revised?.document) document = revised.document
        steps.push(logStep(stepNum + 0.1, 'James', 'Marcus', revised?.log_summary || 'revised', stepStart))

        // James re-checks
        setStage({ text: 'James is re-checking', color: AGENT_COLORS.james })
        await handoffTo(char)
        stepStart = Date.now()
        const recheck = await withWorking(char,
          ['re-checking...'],
          P.JAMES_CHECK,
          { document, original_query: query, briefing, authority: 'advisory', task_spec: s1.task_spec },
          model
        )
        console.log('[chain] James re-check — approved:', recheck.approved)
        await displayWorking(char, recheck.working_steps, recheck.log_summary)
        steps.push(logStep(stepNum + 0.2, 'Marcus', 'James', recheck.log_summary, stepStart))

        // Use recheck delivery lines if available
        if (recheck.delivery_lines?.length) deliveryLines = recheck.delivery_lines

        // Attach notes if still not approved
        if (recheck.approved === false && recheck.issues?.length) {
          deliveryLines.push(`Note: ${recheck.issues.join('; ')}`)
        }
      } else {
        // Approved or advisory — use James's delivery lines
        if (result.delivery_lines?.length) deliveryLines = result.delivery_lines

        // Advisory notes
        if (authority === 'advisory' && result.issues?.length) {
          deliveryLines.push(`Note: ${result.issues.join('; ')}`)
        }
      }
    }

    stepNum++
  }

  // ── Deliver ───────────────────────────────────────────────────────────────
  setStage({ text: 'Delma is delivering', color: AGENT_COLORS.delma })
  await handoffTo(delma)
  await delma.walkTo(delma.def.homeX, delma.def.homeZ)
  delma.faceCamera()
  delma.setLookTarget(CAMERA_POS)

  stepStart = Date.now()
  if (!deliveryLines.length) {
    deliveryLines = [`Delivered: ${s1.task_spec?.deliverable || 'response'}`]
  }

  delma.tickerEl.classList.add('delivery')
  for (const line of deliveryLines) {
    console.log(`  [ticker:Delma] DELIVER: ${line}`)
    await showLine(delma.tickerEl, line, 2000, delma.def.distanceOpacity)
    await sleep(80)
  }
  delma.tickerEl.classList.remove('delivery')
  setStage(null)
  steps.push(logStep(stepNum, 'Delma', 'User', deliveryLines[0] || 'delivered', stepStart))

  const duration = Math.round((Date.now() - t0) / 1000)
  console.log('[chain] complete — %ds | %d steps | pipeline: %s', duration, steps.length, pipeline.map(p => p.agent).join('→'))
  console.table(steps)

  return {
    corrections: 0,
    improvements: pipeline.length,
    duration,
    steps,
    finalContent: document || null
  }
}

// ── Helpers ──────────────────────────────────────────────────────────────────

async function displayWorking(char, workingSteps, logSummary) {
  for (const step of workingSteps || []) {
    console.log(`  [ticker:${char.def.name}] ${step}`)
    await showLine(char.tickerEl, step, 900, char.def.distanceOpacity)
    await sleep(60)
  }
  if (logSummary) {
    console.log(`  [ticker:${char.def.name}] ${logSummary}`)
    await showLine(char.tickerEl, logSummary, 1300, char.def.distanceOpacity)
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

// ── withWorking ───────────────────────────────────────────────────────────────

const MIN_WORKING_MS = 600

async function withWorking(char, loadingMessages, systemPrompt, userMessage, model, maxTokens) {
  model = model || HAIKU
  console.log(`  [api] ${char.def.name} → ${model.split('-').slice(-2).join('-')}`)
  char.startWorking()

  const signal = { done: false }
  const tickerPromise = workingTicker(char.tickerEl, loadingMessages, char.def.distanceOpacity, signal)

  const apiStart = Date.now()
  let result

  try {
    result = await callClaudeWithRetry(
      systemPrompt,
      userMessage,
      () => showLine(char.tickerEl, 'retrying...', 2000, char.def.distanceOpacity),
      model,
      maxTokens
    )
  } catch (err) {
    signal.done = true
    char.stopWorking()
    await tickerPromise
    throw err
  }

  const elapsed = Date.now() - apiStart
  if (elapsed < MIN_WORKING_MS) await sleep(MIN_WORKING_MS - elapsed)

  console.log(`  [api:response] ${char.def.name}`, result)

  signal.done = true
  char.stopWorking()
  await tickerPromise

  return result
}
