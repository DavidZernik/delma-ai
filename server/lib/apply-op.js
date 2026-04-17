// Server-side op applier. Reads current structured data from Supabase,
// applies ops via the pure tab-ops module, writes back both `structured`
// (source of truth) and `content` (rendered view).

import { applyOps, render, emptyData, isStructuredTab, OPS_BY_TAB } from '../../src/tab-ops.js'
import { embeddingDupPreCheck } from './similarity.js'

// Scope can be:
//   { kind: 'org', orgId, filename }
//   { kind: 'project', projectId, userId, filename }
export async function applyOpsToTab(sb, scope, ops) {
  if (!isStructuredTab(scope.filename)) {
    throw new Error(`tab "${scope.filename}" is not a structured tab`)
  }

  const validOps = OPS_BY_TAB[scope.filename]
  for (const o of ops) {
    if (!validOps.includes(o.op)) {
      throw new Error(`op "${o.op}" not valid for "${scope.filename}". Valid: ${validOps.join(', ')}`)
    }
  }

  // Load existing row
  const { table, filter, insertRow, contentColumn } = rowRefs(scope)

  const { data: row, error: selErr } = await sb
    .from(table).select('*').match(filter).maybeSingle()
  if (selErr) throw new Error(`select failed: ${selErr.message}`)

  const currentData = row?.structured || emptyData(scope.filename)

  // Semantic dedup pre-check: if OPENAI_API_KEY is set, embed-match each op's
  // candidate text against the current state. Throws the same error shape
  // handlers do, so the LLM sees a consistent "this already exists" signal.
  // No-op when OPENAI_API_KEY is absent (heuristic dedup in applyOps runs anyway).
  const dupErrors = []
  for (const o of ops) {
    try { await embeddingDupPreCheck(scope.filename, currentData, o) }
    catch (err) { dupErrors.push({ op: o.op, msg: err.message }) }
  }

  const { data: newData, applied, errors } = applyOps(
    scope.filename,
    currentData,
    // Skip ops the semantic check already rejected — they'd re-error with
    // confusing messages from the sync handler.
    dupErrors.length ? ops.filter(o => !dupErrors.find(e => e.op === o.op)) : ops
  )
  const allErrors = [...dupErrors, ...errors]
  const content = render(scope.filename, newData)
  const updatePayload = { structured: newData, [contentColumn]: content }

  if (row) {
    const { error: updErr } = await sb.from(table).update(updatePayload).eq('id', row.id)
    if (updErr) throw new Error(`update failed: ${updErr.message}`)
  } else {
    const { error: insErr } = await sb.from(table).insert({ ...insertRow, ...updatePayload })
    if (insErr) throw new Error(`insert failed: ${insErr.message}`)
  }

  return { applied, errors: allErrors, newData, content }
}

function rowRefs(scope) {
  if (scope.kind === 'org') {
    return {
      table: 'org_memory_notes',
      contentColumn: 'content',
      filter: { org_id: scope.orgId, filename: scope.filename },
      insertRow: {
        org_id: scope.orgId,
        filename: scope.filename,
        permission: 'edit-all',
        owner_id: scope.userId || null
      }
    }
  }
  if (scope.kind === 'project') {
    return {
      table: 'memory_notes',
      contentColumn: 'content',
      filter: { project_id: scope.projectId, filename: scope.filename },
      insertRow: {
        project_id: scope.projectId,
        filename: scope.filename,
        visibility: 'shared',
        owner_id: scope.userId || null
      }
    }
  }
  if (scope.kind === 'diagram') {
    return {
      table: 'diagram_views',
      contentColumn: 'mermaid',
      filter: { project_id: scope.projectId, view_key: scope.filename },
      insertRow: {
        project_id: scope.projectId,
        view_key: scope.filename,
        title: scope.filename === 'architecture' ? 'Architecture' : scope.filename,
        kind: 'flowchart',
        owner_id: scope.userId || null
      }
    }
  }
  throw new Error(`unknown scope kind: ${scope.kind}`)
}

// Classify a tab key into a scope. Returns null if not a structured tab.
//   org:people.md / org:playbook.md  → org_memory_notes
//   memory:decisions.md / ...        → memory_notes
//   diagram:architecture / ...       → diagram_views
export function parseTabKey(tabKey, { projectId, orgId, userId }) {
  const [prefix, filename] = (tabKey || '').split(':')
  if (!filename || !isStructuredTab(filename)) return null
  if (prefix === 'org') return { kind: 'org', orgId, userId, filename }
  if (prefix === 'memory') return { kind: 'project', projectId, userId, filename }
  if (prefix === 'diagram') return { kind: 'diagram', projectId, userId, filename }
  return null
}
