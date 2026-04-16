// Semantic dedup for op handlers via Gemini embeddings.
//
// The sync heuristic in src/tab-ops.js (stemmer + Jaccard + char-subseq) is
// fast and works well for obvious cases, but it misses semantic duplicates
// that don't share vocabulary — e.g. "Marketing BU" vs "Marketing Business
// Unit" (abbreviation), or "journey re-prompts after 48h" vs "re-engagement
// on day 3" (same concept, different words). Embeddings catch both.
//
// This module runs SERVER-SIDE ONLY (inside applyOpsToTab). The handlers in
// tab-ops.js stay sync + browser-safe — the embedding check is an extra layer
// that kicks in just before applyOps runs. If GEMINI_API_KEY isn't set,
// every function here is a no-op and the existing heuristic dedup still runs.
//
// Why Gemini: free tier (1500 req/min, no credit card), latency comparable
// to OpenAI (~100ms/call), quality fine for short-string near-dup detection.
// Switched from OpenAI when that quota ran out mid-test. Swap is a ~5-line
// change if we ever want to upgrade to Voyage for better retrieval quality.
//
// Cache: keyed by normalized text. An org with 100 rules, 50 decisions,
// 200 nodes embeds each text once; subsequent op runs only embed the new
// candidate. Cache lives in-process (fine for single-region Render deploy).

const EMBED_MODEL = 'gemini-embedding-001'
const EMBED_URL = `https://generativelanguage.googleapis.com/v1beta/models/${EMBED_MODEL}:embedContent`

// Thresholds chosen to be slightly tighter than the cheap heuristic — we
// want embeddings to catch ONLY the dupes the heuristic missed, not replay
// everything it already blocked.
const SIM_THRESHOLD = {
  playbook: 0.82,      // rules — conservative; different policies can share vocab
  decision: 0.82,      // same
  node_label: 0.85     // labels — tighter still because short strings embed noisily
}

const cache = new Map()

// Circuit breaker: if the embedding API returns auth/quota errors (401, 403,
// 429), disable for the rest of the process so we don't spam hundreds of
// failed requests per run. Resets on process restart.
let embeddingsDisabled = false
let embeddingsDisabledReason = null

function hasEmbeddings() {
  return !embeddingsDisabled && !!process.env.GEMINI_API_KEY
}

async function embedOne(text) {
  const res = await fetch(`${EMBED_URL}?key=${process.env.GEMINI_API_KEY}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      model: `models/${EMBED_MODEL}`,
      content: { parts: [{ text: normalizeForEmbed(text) }] },
      taskType: 'SEMANTIC_SIMILARITY'
    })
  })
  if (!res.ok) {
    const body = (await res.text()).slice(0, 200)
    // On auth / quota errors, trip the circuit breaker so we don't spam.
    if (res.status === 401 || res.status === 403 || res.status === 429) {
      embeddingsDisabled = true
      embeddingsDisabledReason = `${res.status}: ${body}`
      console.warn('[similarity] embeddings disabled for this process —', embeddingsDisabledReason)
      console.warn('[similarity] heuristic dedup in src/tab-ops.js still runs; this only turns off the semantic layer.')
      return null
    }
    console.warn('[similarity] embed failed', res.status, body)
    return null
  }
  const data = await res.json()
  return data.embedding?.values || null
}

async function embedBatch(texts) {
  if (!hasEmbeddings() || !texts.length) return null
  // Gemini's embedContent endpoint is single-item. We parallelize so latency
  // scales with the longest call rather than the sum. Free-tier quota (1500
  // req/min) is plenty for handler-level dedup workloads.
  const results = await Promise.all(texts.map(t => embedOne(t)))
  // If ANY returned null due to breaker/errors, consider the batch failed —
  // caller will fall back to the heuristic.
  if (results.some(r => r === null)) return null
  return results
}

function normalizeForEmbed(text) {
  // Lowercase + strip extra whitespace. Don't over-normalize — embeddings
  // prefer natural language and handle case/punctuation gracefully.
  return String(text || '').toLowerCase().replace(/\s+/g, ' ').trim()
}

function cacheKey(text) { return normalizeForEmbed(text) }

async function embed(text) {
  const key = cacheKey(text)
  if (!key) return null
  if (cache.has(key)) return cache.get(key)
  const batch = await embedBatch([text])
  if (!batch) return null
  cache.set(key, batch[0])
  return batch[0]
}

function cosine(a, b) {
  if (!a || !b || a.length !== b.length) return 0
  let dot = 0, na = 0, nb = 0
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i]
    na += a[i] * a[i]
    nb += b[i] * b[i]
  }
  const denom = Math.sqrt(na) * Math.sqrt(nb)
  return denom > 0 ? dot / denom : 0
}

// Given a candidate string and a list of existing items, find the most
// similar one by embedding cosine. Returns { item, similarity } if above
// threshold, else null. Fails open — on any error, returns null so the
// write proceeds (heuristic dedup still gates it).
export async function findSemanticDupItem(candidate, list, { field = 'text', threshold }) {
  if (!hasEmbeddings() || !candidate || !list?.length) return null
  try {
    const candEmbed = await embed(candidate)
    if (!candEmbed) return null

    const toEmbed = []
    const needIdx = []
    for (let i = 0; i < list.length; i++) {
      const text = list[i][field]
      if (!text) continue
      const key = cacheKey(text)
      if (!cache.has(key)) {
        toEmbed.push(text)
        needIdx.push(i)
      }
    }
    if (toEmbed.length) {
      const embedded = await embedBatch(toEmbed)
      if (embedded) {
        embedded.forEach((vec, k) => cache.set(cacheKey(toEmbed[k]), vec))
      }
    }

    let best = null
    for (const item of list) {
      const text = item[field]
      if (!text) continue
      const vec = cache.get(cacheKey(text))
      if (!vec) continue
      const sim = cosine(candEmbed, vec)
      if (sim >= threshold && (!best || sim > best.similarity)) {
        best = { item, similarity: sim }
      }
    }
    return best
  } catch (err) {
    console.warn('[similarity] check failed (fail-open):', err.message)
    return null
  }
}

// Server-side pre-check: called from applyOpsToTab. Throws the same error
// shape the sync handler would throw, so the LLM gets a consistent message.
// Only checks add_* ops on the three tabs with semantic dedup: playbook,
// decisions, architecture.
export async function embeddingDupPreCheck(filename, currentData, op) {
  if (!hasEmbeddings()) return
  if (!op?.args) return

  if (filename === 'playbook.md' && op.op === 'add_playbook_rule') {
    const live = (currentData.rules || []).filter(r => !r.superseded_by)
    const dup = await findSemanticDupItem(op.args.text, live, { field: 'text', threshold: SIM_THRESHOLD.playbook })
    if (dup) {
      throw new Error(`Near-duplicate playbook rule (semantic match, sim=${dup.similarity.toFixed(2)}): "${dup.item.text}" (${dup.item.id}). If this supersedes it, call supersede_rule; otherwise skip.`)
    }
  }

  if (filename === 'decisions.md' && op.op === 'add_decision') {
    const live = (currentData.decisions || []).filter(d => !d.superseded_by)
    const dup = await findSemanticDupItem(op.args.text, live, { field: 'text', threshold: SIM_THRESHOLD.decision })
    if (dup) {
      throw new Error(`Near-duplicate decision (semantic match, sim=${dup.similarity.toFixed(2)}): "${dup.item.text}" (${dup.item.id}). If this replaces it, call supersede_decision; otherwise skip.`)
    }
  }

  if (filename === 'architecture' && op.op === 'add_node') {
    // Only check same-kind collisions — semantic dedup across kinds is too
    // aggressive (e.g. a Journey and an Automation with the same name root
    // are different SFMC objects).
    const sameKind = (currentData.nodes || []).filter(n => n.kind === op.args.kind)
    const label = op.args.label || op.args.id
    const dup = await findSemanticDupItem(label, sameKind, { field: 'label', threshold: SIM_THRESHOLD.node_label })
    if (dup) {
      throw new Error(`Near-duplicate architecture node (semantic match, sim=${dup.similarity.toFixed(2)}): "${dup.item.label}" (${dup.item.id}, kind:${dup.item.kind}). Reuse that id for edges, or call merge_nodes if you meant to consolidate.`)
    }
  }
}
