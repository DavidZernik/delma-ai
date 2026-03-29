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
 * Model assignment:
 *   Sonnet: Delma (judgment/coordination), James (validation/skepticism)
 *   Haiku:  Marcus sub-agents (production), Alyssa (synthesis)
 *
 * Step 4 is the core: all sections run their own Marcus→Alyssa→James pipeline
 * simultaneously. No more serial synthesis loop.
 * Routing: needs_arch_review=false skips step 3.
 */

import * as THREE from 'three'
import { callClaudeWithRetry, SONNET, HAIKU } from './api.js'
import { showLine, workingTicker, iconFor, sleep } from './tickers.js'
import { createHandoffSystem } from './handoff.js'
import { runSingleNode } from './subagents.js'
import * as P from './prompts.js'

const CAMERA_POS = new THREE.Vector3(0.5, 3.5, -0.5)

// Model per agent
const MODEL = { Delma: SONNET, James: SONNET, Marcus: HAIKU, Alyssa: HAIKU }

// Token budgets per step role

let handoff = null
let _scene  = null

export function initChain(scene) {
  _scene  = scene
  handoff = createHandoffSystem(scene)
}

// ── Main entry ───────────────────────────────────────────────────────────────

export async function runChain(query, chars, opts = {}) {
  const { delma, marcus, alyssa, james } = chars
  const t0 = Date.now()
  let corrections = 0, improvements = 0
  let finalDocument = ''
  const steps = []

  console.log('[chain] starting:', query)

  // All characters face their desks at start
  marcus.faceDesk(); alyssa.faceDesk(); james.faceDesk()

  // ── Step 1: Delma — decompose ──────────────────────────────────────────────
  delma.faceCamera()
  delma.setLookTarget(CAMERA_POS)

  console.log('[chain] step 1 — Delma decompose')
  let stepStart = Date.now()
  const s1 = await withWorking(delma,
    ['scoping the request...', 'mapping the task...', 'rating complexity...'],
    P.SARAH_DECOMPOSE, query, SONNET
  )
  console.log('[chain] step 1 done — complexity:', s1.complexity, '|', s1.log_summary)
  await displayWorking(delma, s1.working_steps, s1.log_summary)
  steps.push(logStep(1, 'User', 'Delma', s1.log_summary, stepStart))

  const routing    = s1.routing || {}
  const skipAlyssa = s1.skip_alyssa === true
  const jamesModel = s1.model_james === 'sonnet' ? SONNET : HAIKU
  console.log('[chain] plan — skip_alyssa:', skipAlyssa, '| model_james:', s1.model_james, '| needs_arch_review:', routing.needs_arch_review)

  // ── Step 2: Alyssa — architecture (skipped when Delma says structure is obvious) ──
  let approvedArch
  if (skipAlyssa) {
    console.log('[chain] skip_alyssa=true — using Delma\'s subjects directly')
    approvedArch = {
      subjects: s1.subjects || [],
      data_fields: [],
      output_format: s1.task_spec.deliverable
    }
  } else {
    delma.faceCharacter(alyssa)
    delma.setLookTarget(alyssa)
    alyssa.faceCharacter(delma)
    alyssa.setLookTarget(delma)

    console.log('  [ticker:Delma] briefing_to_alyssa:', s1.briefing_to_priya)
    await showLine(delma.tickerEl, s1.briefing_to_priya, 1000, delma.def.distanceOpacity)
    await handoff.send(delma, alyssa)
    delma.faceCamera(); delma.setLookTarget(CAMERA_POS)
    alyssa.faceDesk()

    console.log('[chain] step 2 — Alyssa architecture')
    stepStart = Date.now()
    const s2 = await withWorking(alyssa,
      ['designing structure...', 'defining sections...', 'specifying output format...'],
      P.PRIYA_ARCHITECTURE, s1.task_spec
    )
    console.log('[chain] step 2 done —', s2.log_summary)
    await displayWorking(alyssa, s2.working_steps, s2.log_summary)
    steps.push(logStep(2, 'Delma', 'Alyssa', s2.log_summary, stepStart))

    // ── Step 3: Delma — validate architecture (skipped when not needed) ────────
    await handoff.send(alyssa, delma)
    approvedArch = s2
    if (routing.needs_arch_review !== false) {
      console.log('[chain] step 3 — Delma validate architecture')
      stepStart = Date.now()
      const s3 = await withWorking(delma,
        ['checking framework alignment...', 'verifying scope coverage...'],
        P.SARAH_VALIDATE_ARCHITECTURE, { task_spec: s1.task_spec, architecture: s2 },
        HAIKU
      )
      console.log('[chain] step 3 done — approved:', s3.approved, '| misalignments:', s3.misalignments?.length ?? 0, '|', s3.log_summary)
      await displayWorking(delma, s3.working_steps, s3.log_summary)
      if (s3.misalignments?.length) {
        for (const issue of s3.misalignments) {
          console.log(`  [ticker:Delma] adjusted: ${issue}`)
          await showLine(delma.tickerEl, `adjusted: ${issue}`, 1200, delma.def.distanceOpacity)
          await sleep(60)
        }
      }
      steps.push(logStep(3, 'Delma', 'Delma', s3.log_summary, stepStart))
      approvedArch = s3.approved_architecture || s2
    } else {
      console.log('[chain] needs_arch_review=false — skipping step 3')
    }
  }

  const cappedArch = { ...approvedArch, subjects: (approvedArch.subjects || []).slice(0, 3) }

  // ── Step 4: Parallel pipeline — each section: Marcus → Alyssa → James ──────
  delma.faceCharacter(marcus)
  delma.setLookTarget(marcus)
  marcus.faceCharacter(delma)
  marcus.setLookTarget(delma)

  console.log(`  [ticker:Delma] → Team: ${cappedArch.subjects.join(', ')}`)
  await showLine(delma.tickerEl, `→ Team: ${cappedArch.subjects.join(', ')}`, 1000, delma.def.distanceOpacity)
  await handoff.send(delma, marcus)
  delma.faceCamera(); delma.setLookTarget(CAMERA_POS)
  marcus.faceDesk(); alyssa.faceDesk(); james.faceDesk()

  console.log('[chain] step 4 — parallel section pipelines (Marcus → Alyssa → James per section)')
  stepStart = Date.now()
  marcus.startWorking(); alyssa.startWorking(); james.startWorking()

  // Per-section pipeline: Marcus writes, Alyssa improves, James validates.
  // All sections run this pipeline simultaneously.
  const runSectionPipeline = async (sectionIdx, subject) => {
    const marcusResult = await runSingleNode(_scene, marcus, sectionIdx, {
      label: subject,
      systemPrompt: P.MARCUS_SUBAGENT,
      userMessage: {
        task_spec: {
          objective: s1.task_spec.objective,
          deliverable: s1.task_spec.deliverable,
          key_constraints: s1.task_spec.key_constraints
        },
        section_title: subject,
        fields_to_cover: cappedArch.data_fields
      },
    })
    if (!marcusResult) return null

    const alyssaResult = await runSingleNode(_scene, alyssa, sectionIdx, {
      label: subject,
      systemPrompt: P.ALYSSA_SECTION_IMPROVE,
      userMessage: {
        task_spec: { objective: s1.task_spec.objective },
        section: marcusResult
      }
    })
    const afterAlyssa = alyssaResult || marcusResult

    const jamesResult = await runSingleNode(_scene, james, sectionIdx, {
      label: subject,
      systemPrompt: P.JAMES_SECTION_CHECK,
      userMessage: {
        task_spec: { objective: s1.task_spec.objective },
        james_criteria: s1.james_criteria,
        section: afterAlyssa
      }
    })
    return jamesResult || afterAlyssa
  }

  const sectionResults = await Promise.all(
    cappedArch.subjects.map((subject, idx) => runSectionPipeline(idx, subject))
  )

  marcus.stopWorking(); alyssa.stopWorking(); james.stopWorking()

  const validSections = sectionResults.filter(Boolean)
  finalDocument = validSections
    .map(s => `## ${s.section_title}\n\n${s.content}`)
    .join('\n\n')

  for (const s of validSections) {
    corrections += (s.checks || []).filter(c => c.correction).length
  }
  improvements = validSections.length

  const step4summary = `${validSections.length}/${cappedArch.subjects.length} sections — Marcus wrote, Alyssa improved, James validated in parallel`
  console.log('[chain] step 4 done —', step4summary)
  for (const s of validSections) {
    if (s.log_summary) {
      console.log(`  [ticker:James] ${s.log_summary}`)
      await showLine(james.tickerEl, s.log_summary, 900, james.def.distanceOpacity)
      await sleep(40)
    }
  }
  steps.push(logStep(4, 'Delma', 'Team', step4summary, stepStart))
  await handoff.send(marcus, delma)

  // ── Step 11: Delma — final format + validate ───────────────────────────────
  console.log('[chain] step 11 — Delma assemble + validate')
  stepStart = Date.now()
  const s11 = await withWorking(delma,
    ['final format pass...', 'confirming it answers the question...'],
    P.SARAH_ASSEMBLE_VALIDATE,
    {
      original_query: query,
      task_spec: { objective: s1.task_spec.objective, deliverable: s1.task_spec.deliverable },
      document: finalDocument
    },
    HAIKU
  )
  console.log('  [step11:Delma] gaps_between_output_and_intent:', s11.gaps_between_output_and_intent)
  await displayWorking(delma, s11.working_steps, null)
  if (s11.gaps_between_output_and_intent?.length) {
    for (const gap of s11.gaps_between_output_and_intent) {
      console.log(`  [ticker:Delma] ⚠ gap: ${gap}`)
      await showLine(delma.tickerEl, `⚠ gap: ${gap}`, 2000, delma.def.distanceOpacity)
      await sleep(60)
    }
  }
  console.log(`  [ticker:Delma] ${s11.log_summary}`)
  await showLine(delma.tickerEl, s11.log_summary, 1200, delma.def.distanceOpacity)
  steps.push(logStep(11, 'Delma', 'Delma', s11.log_summary, stepStart))

  // ── Step 12: James — final release ────────────────────────────────────────
  console.log('[chain] step 11 done —', s11.log_summary)
  await handoff.send(delma, james)

  console.log('[chain] step 12 — James final release')
  stepStart = Date.now()
  const s12 = await withWorking(james,
    ['final check before delivery...'],
    P.JAMES_FINAL_RELEASE,
    { document: finalDocument, original_query: query },
    jamesModel
  )
  console.log('  [step12:James] approved:', s12.approved, '| issues:', s12.issues)
  await displayWorking(james, s12.working_steps, s12.log_summary)
  if (s12.issues?.length) {
    for (const issue of s12.issues) {
      console.log(`  [ticker:James] ⚠ ${issue}`)
      await showLine(james.tickerEl, `⚠ ${issue}`, 2000, james.def.distanceOpacity)
      await sleep(60)
    }
  }
  console.log('[chain] step 12 done — approved:', s12.approved, '|', s12.log_summary)
  steps.push(logStep(12, 'James', 'James', s12.log_summary, stepStart))

  // ── Step 13: Delma — deliver ───────────────────────────────────────────────
  console.log('[chain] step 13 — Delma deliver')
  await handoff.send(james, delma)
  await delma.walkTo(delma.def.homeX, delma.def.homeZ)
  delma.faceCamera()
  delma.setLookTarget(CAMERA_POS)

  stepStart = Date.now()
  const s13 = await withWorking(delma,
    ['preparing delivery...'],
    P.SARAH_DELIVER,
    {
      delivery_lines: s11.delivery_lines,
      total_corrections: corrections,
      total_improvements: improvements,
      step_count: steps.length
    },
    HAIKU
  )

  console.log('  [step13:Delma] delivery_lines:', s13.delivery_lines || s11.delivery_lines)
  delma.tickerEl.classList.add('delivery')
  for (const line of s13.delivery_lines || s11.delivery_lines) {
    console.log(`  [ticker:Delma] DELIVER: ${line}`)
    await showLine(delma.tickerEl, line, 2000, delma.def.distanceOpacity)
    await sleep(80)
  }
  delma.tickerEl.classList.remove('delivery')
  steps.push(logStep(13, 'Delma', 'User', s13.log_summary, stepStart))

  const duration = Math.round((Date.now() - t0) / 1000)
  console.log('[chain] complete — %ds | %d steps | %d corrections | %d improvements', duration, steps.length, corrections, improvements)
  console.table(steps)

  const finalContent = finalDocument || null
  console.log('[chain] final_content length:', finalContent?.length ?? 0)

  return { corrections, improvements, duration, steps, finalContent }
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

async function withWorking(char, loadingMessages, systemPrompt, userMessage, model) {
  model = model || MODEL[char.def.name] || SONNET
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
      model
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
