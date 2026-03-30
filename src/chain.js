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
 * Lead agent routing (set by Delma at step 1):
 *   lead_agent=sarah  → Sarah reads request, forms opinion, briefs Marcus per section
 *                       Use for: advice, strategy, judgment, "what should I do?" tasks
 *   lead_agent=marcus → Marcus produces sections; Sarah optionally structures or improves
 *                       Use for: writing, guides, plans, production tasks
 *
 * Marcus-led sub-routing:
 *   skip_sarah=true  → Marcus writes directly (structure obvious); skips steps 2, 3, 11
 *   skip_sarah=false → Sarah does architecture (step 2) + section improvement
 *
 * James rejection → step 12b (Marcus revise) + 12c (James re-check), one retry
 */

import * as THREE from 'three'
import { callClaudeWithRetry, callSearch, SONNET, HAIKU, DEEPSEEK_V3 } from './api.js'
import { showLine, workingTicker, iconFor, sleep, setTicker } from './tickers.js'
import { createHandoffSystem } from './handoff.js'
import { runSingleNode } from './subagents.js'
import * as P from './prompts.js'

const CAMERA_POS = new THREE.Vector3(0.5, 3.5, -0.5)

function setStage(text) {
  const el = document.getElementById('stage-bar')
  if (!el) return
  if (!text) { el.classList.remove('active'); return }
  el.textContent = text
  el.classList.add('active')
}

// Cost mode: 'budget' routes agents to cheaper models by default.
// Change to 'quality' to prefer Haiku/Sonnet.
const COST_MODE = 'budget'
const ROUTING_POLICY = {
  budget:  'ROUTING POLICY: Default all agents to deepseek unless the task genuinely requires human-level judgment. Prefer cheaper models.',
  quality: 'ROUTING POLICY: Prefer haiku for production tasks, sonnet for judgment-heavy tasks. Use deepseek for simple drafting.'
}

const MODEL_MAP = { deepseek: DEEPSEEK_V3, haiku: HAIKU, sonnet: SONNET }

// Default model per agent (fallback if Delma doesn't specify).
const MODEL = { Delma: HAIKU, Marcus: DEEPSEEK_V3, Sarah: DEEPSEEK_V3, James: HAIKU }

// Token budgets per step role

let handoff = null
let _scene  = null

export function initChain(scene) {
  _scene  = scene
  handoff = createHandoffSystem(scene)
}

// ── Main entry ───────────────────────────────────────────────────────────────

export async function runChain(query, chars, opts = {}) {
  const { delma, marcus, sarah, james } = chars
  const t0 = Date.now()
  let corrections = 0, improvements = 0
  let finalDocument = ''
  const steps = []

  console.log('[chain] starting:', query)

  // All characters face their desks at start
  marcus.faceDesk(); sarah.faceDesk(); james.faceDesk()

  // ── Step 1: Delma — decompose ──────────────────────────────────────────────
  setStage('Planning')
  delma.faceCamera()
  delma.setLookTarget(CAMERA_POS)

  console.log('[chain] step 1 — Delma decompose')
  let stepStart = Date.now()
  const delmaPrompt = ROUTING_POLICY[COST_MODE] + '\n\n' + P.DELMA_DECOMPOSE
  const s1 = await withWorking(delma,
    ['scoping the request...', 'mapping the task...', 'rating complexity...'],
    delmaPrompt, query, HAIKU
  )
  console.log('[chain] step 1 done — complexity:', s1.complexity, '|', s1.log_summary)
  await displayWorking(delma, s1.working_steps, s1.log_summary)
  steps.push(logStep(1, 'User', 'Delma', s1.log_summary, stepStart))

  const routing     = s1.routing || {}
  const leadAgent   = s1.lead_agent === 'sarah' ? 'sarah' : 'marcus'
  const skipSarah   = leadAgent === 'marcus' && s1.skip_sarah === true
  const marcusModel = MODEL_MAP[s1.model_marcus] ?? DEEPSEEK_V3
  const sarahModel  = MODEL_MAP[s1.model_sarah]  ?? DEEPSEEK_V3
  const jamesModel  = MODEL_MAP[s1.model_james]  ?? HAIKU
  const wordBudget = s1.task_spec?.word_budget || 800
  console.log('[chain] plan — lead_agent:', leadAgent, '| skip_sarah:', skipSarah, '| model_james:', s1.model_james, '| word_budget:', wordBudget)

  // ── Step 1.5: Web search (if Delma flagged it) ────────────────────────────
  let searchContext = ''
  if (s1.needs_search && s1.search_queries?.length) {
    console.log('[chain] step 1.5 — web search:', s1.search_queries)
    setStage('Researching')
    delma.startWorking()
    await showLine(delma.tickerEl, 'searching the web...', 1200, delma.def.distanceOpacity)

    const chunks = []
    for (const query of s1.search_queries.slice(0, 3)) {
      try {
        const { context } = await callSearch(query, 5)
        if (context) chunks.push(context)
        console.log(`  [search] "${query}" → ${context?.length ?? 0} chars`)
      } catch (e) {
        console.warn(`  [search] "${query}" failed:`, e.message)
      }
    }

    if (chunks.length) {
      searchContext = chunks.join('\n\n')
      await showLine(delma.tickerEl, `web: ${chunks.length} queries complete`, 1200, delma.def.distanceOpacity)
      console.log('[chain] step 1.5 done — search_context length:', searchContext.length)
    }
    delma.stopWorking()
  }

  // ── Step 2: Sarah or architecture phase ───────────────────────────────────
  let approvedArch
  let sarahLead = null  // populated when lead_agent=sarah

  if (leadAgent === 'sarah') {
    // Sarah-led: she reads the full request, forms the strategic opinion, briefs Marcus
    delma.faceCharacter(sarah)
    delma.setLookTarget(sarah)
    sarah.faceCharacter(delma)
    sarah.setLookTarget(delma)

    console.log('  [ticker:Delma] briefing Sarah (lead):', s1.briefing_to_sarah)
    await showLine(delma.tickerEl, s1.briefing_to_sarah, 1000, delma.def.distanceOpacity)
    await handoff.send(delma, sarah)
    delma.faceCamera(); delma.setLookTarget(CAMERA_POS)
    sarah.faceDesk()

    setStage('Strategic planning')
    console.log('[chain] step 2 — Sarah strategic lead')
    stepStart = Date.now()
    sarahLead = await withWorking(sarah,
      ['reading the situation...', 'forming a position...', 'structuring the recommendation...'],
      P.SARAH_LEAD, { task_spec: s1.task_spec, original_query: query, word_budget: wordBudget }, sarahModel
    )
    console.log('[chain] step 2 done — recommendation:', sarahLead.recommendation, '|', sarahLead.log_summary)
    await displayWorking(sarah, sarahLead.working_steps, sarahLead.log_summary)
    steps.push(logStep(2, 'Delma', 'Sarah', sarahLead.log_summary, stepStart))

    await handoff.send(sarah, marcus)

    // Build approvedArch from Sarah's lead output
    approvedArch = {
      subjects: (sarahLead.subjects || []).slice(0, 3),
      section_briefs: sarahLead.section_briefs || [],
      shared_context: sarahLead.shared_context || '',
      recommendation: sarahLead.recommendation,
      data_fields: []
    }

  } else if (skipSarah) {
    console.log('[chain] skip_sarah=true — using Delma\'s subjects directly')
    approvedArch = {
      subjects: s1.subjects || [],
      data_fields: [],
      output_format: s1.task_spec.deliverable
    }
  } else {
    // Marcus-led, Sarah does architecture
    delma.faceCharacter(sarah)
    delma.setLookTarget(sarah)
    sarah.faceCharacter(delma)
    sarah.setLookTarget(delma)

    console.log('  [ticker:Delma] briefing_to_sarah:', s1.briefing_to_sarah)
    await showLine(delma.tickerEl, s1.briefing_to_sarah, 1000, delma.def.distanceOpacity)
    await handoff.send(delma, sarah)
    delma.faceCamera(); delma.setLookTarget(CAMERA_POS)
    sarah.faceDesk()

    setStage('Architecture')
    console.log('[chain] step 2 — Sarah architecture')
    stepStart = Date.now()
    const s2 = await withWorking(sarah,
      ['designing structure...', 'defining sections...', 'specifying output format...'],
      P.SARAH_ARCHITECTURE, { ...s1.task_spec, word_budget: wordBudget }, sarahModel
    )
    console.log('[chain] step 2 done —', s2.log_summary)
    await displayWorking(sarah, s2.working_steps, s2.log_summary)
    steps.push(logStep(2, 'Delma', 'Sarah', s2.log_summary, stepStart))

    // ── Step 3: Delma — validate architecture ──────────────────────────────
    await handoff.send(sarah, delma)
    approvedArch = s2
    if (routing.needs_arch_review !== false) {
      setStage('Review')
      console.log('[chain] step 3 — Delma validate architecture')
      stepStart = Date.now()
      const s3 = await withWorking(delma,
        ['checking framework alignment...', 'verifying scope coverage...'],
        P.DELMA_VALIDATE_ARCHITECTURE, { task_spec: { ...s1.task_spec, word_budget: wordBudget }, architecture: s2 },
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
      const base = s3.approved_architecture || s2
      approvedArch = { ...base, shared_context: base.shared_context || s2.shared_context }
    } else {
      console.log('[chain] needs_arch_review=false — skipping step 3')
    }
  }

  const cappedArch = {
    ...approvedArch,
    subjects: (approvedArch.subjects || []).slice(0, 3),
    shared_context: searchContext
      ? `${approvedArch.shared_context || ''}\n\nWEB RESEARCH:\n${searchContext}`.trim()
      : approvedArch.shared_context || ''
  }
  const sectionCount = cappedArch.subjects.length || 1
  const perSectionBudget = Math.floor(wordBudget / sectionCount)
  console.log('[chain] budget — word_budget:', wordBudget, '| sections:', sectionCount, '| per_section:', perSectionBudget)

  // ── Step 4: Parallel pipeline ──────────────────────────────────────────
  setStage('Writing & validation')
  delma.faceCharacter(marcus)
  delma.setLookTarget(marcus)
  marcus.faceCharacter(delma)
  marcus.setLookTarget(delma)

  console.log(`  [ticker:Delma] → Team: ${cappedArch.subjects.join(', ')}`)
  await showLine(delma.tickerEl, `→ Team: ${cappedArch.subjects.join(', ')}`, 1000, delma.def.distanceOpacity)
  if (leadAgent !== 'sarah') await handoff.send(delma, marcus)
  delma.faceCamera(); delma.setLookTarget(CAMERA_POS)
  marcus.faceDesk(); sarah.faceDesk(); james.faceDesk()

  if (leadAgent === 'sarah') {
    console.log('[chain] step 4 — parallel section pipelines (Sarah leads: Marcus support → James per section)')
    marcus.startWorking(); james.startWorking()
  } else if (skipSarah) {
    console.log('[chain] step 4 — parallel section pipelines (Marcus → James per section)')
    marcus.startWorking(); james.startWorking()
  } else {
    console.log('[chain] step 4 — parallel section pipelines (Marcus → Sarah → James per section)')
    marcus.startWorking(); sarah.startWorking(); james.startWorking()
  }

  stepStart = Date.now()

  const runSectionPipeline = async (sectionIdx, subject) => {
    // Find Sarah's brief for this section (sarah-led only)
    const sectionBrief = cappedArch.section_briefs?.find(b => b.section === subject)

    const marcusPrompt = leadAgent === 'sarah' ? P.MARCUS_SUPPORT : P.MARCUS_SUBAGENT
    const marcusMessage = leadAgent === 'sarah'
      ? {
          sarah_recommendation: cappedArch.recommendation,
          shared_context: cappedArch.shared_context || '',
          all_sections: cappedArch.subjects,
          section_title: subject,
          section_brief: sectionBrief || { section: subject, argument: subject, marcus_task: 'provide supporting details' },
          section_word_limit: perSectionBudget
        }
      : {
          task_spec: {
            objective: s1.task_spec.objective,
            deliverable: s1.task_spec.deliverable,
            key_constraints: s1.task_spec.key_constraints
          },
          shared_context: cappedArch.shared_context || '',
          all_sections: cappedArch.subjects,
          section_title: subject,
          fields_to_cover: cappedArch.data_fields,
          section_word_limit: perSectionBudget
        }

    setTicker(marcus.tickerEl, `writing "${subject}"...`, marcus.def.distanceOpacity)
    const marcusResult = await runSingleNode(_scene, marcus, sectionIdx, {
      label: subject,
      systemPrompt: marcusPrompt,
      userMessage: marcusMessage,
      model: marcusModel
    })
    if (!marcusResult) return null

    let afterSarah = marcusResult
    if (leadAgent === 'marcus' && !skipSarah) {
      setTicker(sarah.tickerEl, `refining "${subject}"...`, sarah.def.distanceOpacity)
      const sarahResult = await runSingleNode(_scene, sarah, sectionIdx, {
        label: subject,
        systemPrompt: P.SARAH_SECTION_IMPROVE,
        userMessage: {
          task_spec: { objective: s1.task_spec.objective, key_constraints: s1.task_spec.key_constraints },
          section: marcusResult
        },
        model: sarahModel
      })
      afterSarah = sarahResult || marcusResult
    }

    setTicker(james.tickerEl, `checking "${subject}"...`, james.def.distanceOpacity)
    const jamesResult = await runSingleNode(_scene, james, sectionIdx, {
      label: subject,
      systemPrompt: P.JAMES_SECTION_CHECK,
      userMessage: {
        task_spec: { objective: s1.task_spec.objective, key_constraints: s1.task_spec.key_constraints },
        james_criteria: s1.james_criteria,
        section: afterSarah
      },
      model: jamesModel
    })
    return jamesResult || afterSarah
  }

  const sectionResults = await Promise.all(
    cappedArch.subjects.map((subject, idx) => runSectionPipeline(idx, subject))
  )

  if (leadAgent === 'sarah' || skipSarah) {
    marcus.stopWorking(); james.stopWorking()
  } else {
    marcus.stopWorking(); sarah.stopWorking(); james.stopWorking()
  }

  const validSections = sectionResults.filter(Boolean)

  for (const s of validSections) {
    corrections += (s.checks || []).filter(c => c.correction).length
  }
  improvements = validSections.length

  for (const s of validSections) {
    if (s.log_summary) {
      console.log(`  [ticker:James] ${s.log_summary}`)
      await showLine(james.tickerEl, s.log_summary, 900, james.def.distanceOpacity)
      await sleep(40)
    }
  }

  // ── Marcus assembly: stitch sections into one coherent document ────────────
  setStage('Assembly')
  marcus.startWorking()
  console.log('[chain] step 4b — Marcus assembly pass')
  const assemblyResult = await withWorking(marcus,
    ['reading across sections...', 'checking coherence...', 'assembling...'],
    P.MARCUS_ASSEMBLE,
    {
      task_spec: { objective: s1.task_spec.objective, deliverable: s1.task_spec.deliverable },
      shared_context: cappedArch.shared_context || '',
      sections: validSections.map(s => ({ section_title: s.section_title, content: s.content }))
    },
    marcusModel, 12000
  )
  marcus.stopWorking()

  finalDocument = assemblyResult?.document
    || validSections.map(s => `## ${s.section_title}\n\n${s.content}`).join('\n\n')

  if (assemblyResult?.coherence_fixes?.length) {
    for (const fix of assemblyResult.coherence_fixes) {
      console.log(`  [ticker:Marcus] ↳ ${fix}`)
      await showLine(marcus.tickerEl, `↳ ${fix}`, 1000, marcus.def.distanceOpacity)
      await sleep(50)
    }
  }
  console.log('[chain] step 4b done —', assemblyResult?.log_summary)
  await showLine(marcus.tickerEl, assemblyResult?.log_summary || 'assembled', 1200, marcus.def.distanceOpacity)

  const step4summary = leadAgent === 'sarah'
    ? `${validSections.length}/${cappedArch.subjects.length} sections — Sarah led, Marcus supported, James validated in parallel`
    : skipSarah
      ? `${validSections.length}/${cappedArch.subjects.length} sections — Marcus wrote, James validated in parallel`
      : `${validSections.length}/${cappedArch.subjects.length} sections — Marcus wrote, Sarah improved, James validated in parallel`
  steps.push(logStep(4, 'Delma', 'Team', step4summary, stepStart))
  await handoff.send(marcus, delma)

  // ── Step 11: Delma — final format + validate (skipped for simple/sarah-led tasks) ────
  let s11 = null
  if (leadAgent === 'marcus' && !skipSarah) {
    setStage('Final review')
    console.log('[chain] step 11 — Delma assemble + validate')
    stepStart = Date.now()
    s11 = await withWorking(delma,
      ['final format pass...', 'confirming it answers the question...'],
      P.DELMA_ASSEMBLE_VALIDATE,
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
    await handoff.send(delma, james)
  } else {
    console.log('[chain] skipping step 11 — lead_agent:', leadAgent, '| skip_sarah:', skipSarah)
  }

  // ── Step 12: James — final release ────────────────────────────────────────
  setStage('Quality check')
  console.log('[chain] step 12 — James final release')
  stepStart = Date.now()
  const s12 = await withWorking(james,
    ['final check before delivery...'],
    P.JAMES_FINAL_RELEASE,
    { document: finalDocument, original_query: query, james_criteria: s1.james_criteria },
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

  // ── Step 12b/12c: revision loop — fires once if James rejected ─────────────
  let finalJamesResult = s12
  if (s12.approved === false && s12.issues?.length) {
    setStage('Revising')
    console.log('[chain] step 12b — Marcus revising based on James rejection')
    await handoff.send(james, marcus)
    marcus.startWorking()
    stepStart = Date.now()
    const s12b = await withWorking(marcus,
      ['addressing James\'s feedback...', 'revising...'],
      P.MARCUS_REVISE,
      { document: finalDocument, issues: s12.issues },
      marcusModel
    )
    marcus.stopWorking()
    console.log('[chain] step 12b done —', s12b?.log_summary)
    if (s12b?.changes_made?.length) {
      for (const change of s12b.changes_made) {
        console.log(`  [ticker:Marcus] ↳ ${change}`)
        await showLine(marcus.tickerEl, `↳ ${change}`, 1000, marcus.def.distanceOpacity)
        await sleep(50)
      }
    }
    steps.push(logStep('12b', 'James', 'Marcus', s12b?.log_summary || 'revised', stepStart))

    if (s12b?.document) {
      finalDocument = s12b.document

      console.log('[chain] step 12c — James re-checking revised document')
      await handoff.send(marcus, james)
      stepStart = Date.now()
      const s12c = await withWorking(james,
        ['re-checking revised document...'],
        P.JAMES_FINAL_RELEASE,
        { document: finalDocument, original_query: query, james_criteria: s1.james_criteria },
        jamesModel
      )
      console.log('  [step12c:James] approved:', s12c.approved, '|', s12c.log_summary)
      await displayWorking(james, s12c.working_steps, s12c.log_summary)
      steps.push(logStep('12c', 'Marcus', 'James', s12c.log_summary, stepStart))
      finalJamesResult = s12c
    }
  }

  // ── Step 13: Delma — deliver (display-only, no API call) ──────────────────
  setStage('Delivering')
  console.log('[chain] step 13 — Delma deliver (display-only)')
  await handoff.send(james, delma)
  await delma.walkTo(delma.def.homeX, delma.def.homeZ)
  delma.faceCamera()
  delma.setLookTarget(CAMERA_POS)

  stepStart = Date.now()

  // Use delivery_lines generated by James — no API call needed
  const deliverySource = finalJamesResult.delivery_lines?.length
    ? 'finalJamesResult'
    : s11?.delivery_lines?.length
      ? 's11'
      : 'fallback'
  console.log('[chain] step 13 — delivery_lines source:', deliverySource)

  const deliveryLines = finalJamesResult.delivery_lines?.length
    ? finalJamesResult.delivery_lines
    : s11?.delivery_lines?.length
      ? s11.delivery_lines
      : [`Delivered: ${s1.task_spec.deliverable}`, `${corrections} corrections, ${improvements} improvements`]

  if (finalJamesResult.approved === false && finalJamesResult.issues?.length) {
    deliveryLines.push(`Note: ${finalJamesResult.issues.join('; ')}`)
  }

  console.log('  [step13:Delma] delivery_lines:', deliveryLines)
  delma.tickerEl.classList.add('delivery')
  for (const line of deliveryLines) {
    console.log(`  [ticker:Delma] DELIVER: ${line}`)
    await showLine(delma.tickerEl, line, 2000, delma.def.distanceOpacity)
    await sleep(80)
  }
  delma.tickerEl.classList.remove('delivery')
  setStage(null)
  steps.push(logStep(13, 'Delma', 'User', deliveryLines[0] || 'delivered', stepStart))

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

async function withWorking(char, loadingMessages, systemPrompt, userMessage, model, maxTokens) {
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
