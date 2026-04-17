// Deterministic-ish fidelity score per narrative, decoupled from Sonnet critique.
//
// Each narrative has an `expected` object with natural-language items per tab
// (e.g. `people: ['Sarah (PM)', 'Keyona Abbott (Engineer, reports to Sarah)']`).
// This module embeds each expected item and each captured item in the final
// workspace state, then computes pair-wise cosine similarity to determine
// whether each expected item was "captured" in some form.
//
// Why this matters: the Sonnet critic produces a 1-5 quality score that
// swings ±1 across runs of the same narrative due to LLM variance. Two
// signals per sim:
//   - fidelity (this file): stable, reproducible. "% of expected items captured."
//   - quality (Sonnet critique): judgmental, variance-prone. "How usable was it?"
//
// Fidelity answers "did we capture it?" Quality answers "was the capture good?"
// Together they separate real regressions from critic noise.

import { findSemanticDupItem } from '../lib/similarity.js'

// Extract specific named entities from a prose expected item. The narratives'
// `expected` blocks write things like "Nodes: NewSubscribers_Daily (deSource),
// Welcome_Send_Daily (automation), three emails, decision split" — a single
// prose string that bundles multiple distinct things. If we match this
// against the captured state at the prose level, any one capture satisfies
// the whole string and fidelity overcounts.
//
// This pulls out identifier-shaped tokens (PascalCase, snake_case, DOT.case)
// so we can require each named entity individually.
function extractNamedEntities(prose) {
  if (!prose) return []
  const tokens = new Set()
  // Pattern: two-or-more-segment identifiers like Welcome_Email_Day3,
  // SP_Birthday_Main, BirthdayJourney_v3, populi-sendable-daily,
  // Birthday_Patients_Daily. Require at least one underscore/dash OR a
  // CamelCase transition to avoid picking up ordinary words like "source".
  const idLike = prose.match(/\b[A-Za-z][A-Za-z0-9]*(?:[_\-][A-Za-z0-9]+){1,}\b/g) || []
  for (const t of idLike) tokens.add(t)
  // PascalCase / camelCase words with at least two capitals — catches
  // "BirthdayJourney", "WelcomeJourney", "CloudPage"
  const camel = prose.match(/\b[A-Z][a-z]+(?:[A-Z][a-z]+){1,}\b/g) || []
  for (const t of camel) tokens.add(t)
  return [...tokens]
}

// Pull captured items out of the final workspace state, one flattened string
// per "thing" in each tab. These are what we compare expected items against.
function extractCapturedItems(finalState) {
  const buckets = {
    people: [],
    decisions: [],
    actions: [],
    environment: [],
    playbook: [],
    architecture: []
  }

  const peopleTab = finalState['org:people.md']
  for (const p of (peopleTab?.people || [])) {
    const bits = [p.name, p.role, p.kind].filter(Boolean)
    buckets.people.push({ text: bits.join(' '), raw: p })
  }

  const decisionsTab = finalState['memory:decisions.md']
  for (const d of (decisionsTab?.decisions || [])) {
    if (d.superseded_by) continue
    buckets.decisions.push({ text: `${d.text}${d.owner ? ` (${d.owner})` : ''}`, raw: d })
  }
  for (const a of (decisionsTab?.actions || [])) {
    buckets.actions.push({ text: `${a.text}${a.owner ? ` (${a.owner})` : ''}${a.due ? ` due ${a.due}` : ''}`, raw: a })
  }

  const envTab = finalState['memory:environment.md']
  for (const e of (envTab?.entries || [])) {
    buckets.environment.push({ text: `${e.key} = ${e.value}${e.note ? ` (${e.note})` : ''}`, raw: e })
  }

  const playbookTab = finalState['org:playbook.md']
  for (const r of (playbookTab?.rules || [])) {
    if (r.superseded_by) continue
    buckets.playbook.push({ text: r.text, raw: r })
  }

  const archTab = finalState['diagram:architecture']
  for (const n of (archTab?.nodes || [])) {
    const layerName = n.layer
      ? (archTab.layers || []).find(l => l.id === n.layer)?.title || n.layer
      : null
    buckets.architecture.push({
      text: `${n.label || n.id} (${n.kind}${layerName ? `, layer: ${layerName}` : ''})${n.note ? ` — ${n.note}` : ''}`,
      raw: n,
      type: 'node'
    })
  }
  for (const e of (archTab?.edges || [])) {
    buckets.architecture.push({
      text: `edge ${e.from} → ${e.to}${e.label ? ` [${e.label}]` : ''}`,
      raw: e,
      type: 'edge'
    })
  }
  for (const l of (archTab?.layers || [])) {
    buckets.architecture.push({ text: `layer: ${l.title}`, raw: l, type: 'layer' })
  }

  return buckets
}

// Cosine-similarity threshold above which an expected item counts as
// "captured" by the best-matching captured item in the same tab. Tuned
// conservative (0.55) because prose-expected and structured-captured have
// different surface forms — we don't need embedding-level polish, just
// "are we talking about the same concept."
const MATCH_THRESHOLD = 0.55

// Per-tab fidelity. For each expected prose item, FIRST decompose it into
// the specific named entities it mentions (identifiers like
// Welcome_Email_Day3 or BirthdayJourney_v3). Require each named entity to
// be individually captured. The prose item is only "fully matched" when
// the concept matches AND every named entity in it is present.
//
// This prevents the overcounting that made early fidelity runs hit 100%
// when obvious specifics were missing. If the expected says "three emails:
// Day0, Day3, Day7" and only Day0 is captured, the prose-level embedding
// match still fires, but the entity check catches that 2 of 3 specific
// names are absent.
async function scoreTab(expected, captured) {
  if (!expected?.length) return { expected: 0, captured: captured.length, matched: 0, missed: [], score: 1 }
  if (!captured.length) return { expected: expected.length, captured: 0, matched: 0, missed: expected.slice(), score: 0 }

  let totalItems = 0    // counts concept + each named entity as separate items
  let matched = 0
  const missed = []
  const missingEntities = []

  const capturedText = captured.map(c => c.text).join(' | ').toLowerCase()

  for (const expText of expected) {
    const entities = extractNamedEntities(expText)

    // Concept-level match (prose-to-prose embedding)
    const conceptHit = await findSemanticDupItem(expText, captured, { field: 'text', threshold: MATCH_THRESHOLD })
    totalItems += 1
    if (conceptHit) matched++
    else missed.push(expText)

    // Entity-level checks — each named entity counts as its own item.
    // These are identifiers (Welcome_Email_Day3, Populi_Sync_Auto, etc.).
    // NO embedding fallback — embeddings consider Day0 and Day3 ~0.9 similar,
    // which would falsely mark Day3 as present when only Day0 was captured.
    // Identifiers must match exactly (case + separators normalized).
    for (const entity of entities) {
      totalItems += 1
      const lower = entity.toLowerCase()
      const lowerLoose = lower.replace(/[_\-]/g, '')
      const inCaptured = capturedText.includes(lower) || capturedText.replace(/[_\-]/g, '').includes(lowerLoose)
      if (inCaptured) matched++
      else missingEntities.push(entity)
    }
  }

  return {
    expected: totalItems,
    captured: captured.length,
    matched,
    missed: missed.concat(missingEntities.length ? missingEntities.map(e => `(entity) ${e}`) : []),
    score: totalItems ? matched / totalItems : 1
  }
}

// False-positive detection: were things in `shouldNOTcapture` actually captured?
// Flattens all captured strings across tabs and checks each forbidden item
// against the combined set.
async function scoreForbidden(forbidden, allCaptured) {
  if (!forbidden?.length || !allCaptured.length) return { count: 0, hits: [] }
  const hits = []
  for (const forbidText of forbidden) {
    // High threshold (0.82) — forbidden checks should only fire on clear
    // matches. "Casey (admin, person)" matching "don't invent collaborators"
    // at 0.7 was a false positive; capturing the user's own name is fine,
    // inventing teammates is not. A real forbidden match (e.g. capturing a
    // team structure the user explicitly said doesn't exist) will score 0.85+.
    const hit = await findSemanticDupItem(forbidText, allCaptured, { field: 'text', threshold: 0.82 })
    if (hit) hits.push({ forbidden: forbidText, captured: hit.item.text, similarity: hit.similarity })
  }
  return { count: hits.length, hits }
}

export async function computeFidelity(narrative, finalState) {
  const exp = narrative.expected || {}
  const captured = extractCapturedItems(finalState)

  // Extract every identifier-shaped token the user explicitly named in the
  // conversation itself, and add them as implicit expected items. This
  // catches "Welcome_Email_Day3" mentioned in turn 5 even if the expected
  // prose only says "three emails". Identifier pattern = snake_case,
  // kebab-case, or PascalCase compound — so we don't pick up "Casey" or
  // normal English from chitchat turns.
  const turnEntities = new Set()
  for (const turn of (narrative.turns || [])) {
    for (const e of extractNamedEntities(String(turn))) turnEntities.add(e)
  }
  // Remove entities already explicitly listed in expected (they'll be
  // picked up via the regular path).
  const allExpectedProse = [
    ...(exp.architecture || []),
    ...(exp.environment || []),
    ...(exp.decisions || []),
    ...(exp.people || []),
    ...(exp.playbook || []),
    ...(exp.actions || [])
  ].join(' ')
  for (const e of extractNamedEntities(allExpectedProse)) turnEntities.delete(e)
  // Remove ones the narrative explicitly told us NOT to capture.
  for (const n of (exp.shouldNOTcapture || [])) {
    for (const e of extractNamedEntities(String(n))) turnEntities.delete(e)
  }
  const implicitFromTurns = [...turnEntities]

  // Architecture is a single flat bucket in captured but expected often
  // comes in as one long prose string that mentions nodes + edges + layers
  // together. Score it as a single bucket.
  const perTab = {
    people:       await scoreTab(exp.people || [],       captured.people),
    decisions:    await scoreTab(exp.decisions || [],    captured.decisions),
    actions:      await scoreTab(exp.actions || [],      captured.actions),
    environment:  await scoreTab(exp.environment || [],  captured.environment),
    playbook:     await scoreTab(exp.playbook || [],     captured.playbook),
    architecture: await scoreTab(exp.architecture || [], captured.architecture),
    // Catch-all bucket for identifier-shaped tokens from turns that the
    // expected prose didn't name. Most of these end up in architecture
    // or environment in practice.
    turn_entities: implicitFromTurns.length
      ? await scoreTab(implicitFromTurns, [...captured.architecture, ...captured.environment, ...captured.playbook, ...captured.people])
      : { expected: 0, captured: 0, matched: 0, missed: [], score: 1 }
  }

  const allCaptured = Object.values(captured).flat()
  const forbidden = await scoreForbidden(exp.shouldNOTcapture || [], allCaptured)

  const expectedCount = Object.values(perTab).reduce((a, b) => a + b.expected, 0)
  const matchedCount  = Object.values(perTab).reduce((a, b) => a + b.matched, 0)
  const overallScore = expectedCount ? matchedCount / expectedCount : null

  return {
    score: overallScore,                 // 0..1, or null if narrative has no expected items
    percent: overallScore !== null ? Math.round(overallScore * 100) : null,
    matched: matchedCount,
    expected: expectedCount,
    forbidden_hits: forbidden.count,     // > 0 = captured something it was told not to
    per_tab: perTab,
    forbidden: forbidden.hits
  }
}
