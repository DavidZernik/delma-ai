// Delma Express Server — simplified for Supabase backend
// Handles: static file serving (production) + chat proxy (AI API keys stay server-side)
// Auth, workspace CRUD, memory CRUD, real-time — all handled by Supabase directly from the client.

import express from 'express'
import { config } from 'dotenv'
import { fileURLToPath } from 'url'
import { dirname, join, resolve } from 'path'
import { writeFile } from 'fs/promises'
import { createClient } from '@supabase/supabase-js'
import { generateClaudeMd } from './lib/summarizer.js'
import { applyOpsToTab, parseTabKey } from './lib/apply-op.js'
import { requireUser, requireOrgMembership, requireWorkspaceMembership } from './lib/auth.js'
import { parseStructuredContent } from './lib/parse-tab.js'
import { render, isStructuredTab } from '../src/tab-ops.js'
import { runAllLayers, runOvernight } from './quality/runner.js'
import { renderLogsPage } from './quality/logs-page.js'
import { ANTHROPIC_URL, anthropicHeaders } from './lib/llm.js'

// override: true ensures .env values beat any empty shell env vars
// (e.g. ANTHROPIC_API_KEY="" set globally by Claude Desktop)
config({ override: true })

const __dirname = dirname(fileURLToPath(import.meta.url))
const app = express()
const PORT = process.env.PORT || 3001

app.use(express.json({ limit: '4mb' }))

// ── Health ───────────────────────────────────────────────────────────────────

app.get('/api/health', (req, res) => {
  res.json({ ok: true, version: '2.0.0' })
})

// ── Chat Proxy ───────────────────────────────────────────────────────────────
// AI API keys stay server-side. Client sends model + messages, server proxies.

async function callOpenAICompatible(apiUrl, apiKey, provider, model, system, user, max_tokens, res) {
  let response
  try {
    response = await fetch(apiUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${apiKey}` },
      body: JSON.stringify({
        model,
        max_tokens: max_tokens ?? 2000,
        messages: [
          ...(system ? [{ role: 'system', content: system }] : []),
          { role: 'user', content: user }
        ]
      })
    })
  } catch (e) {
    return res.status(502).json({ error: `Failed to reach ${provider} API: ${e.message}` })
  }
  if (!response.ok) {
    const text = await response.text()
    return res.status(response.status).json({ error: `${provider} ${response.status}: ${text || '(empty)'}` })
  }
  const data = await response.json()
  return res.json({ content: [{ text: data.choices?.[0]?.message?.content || '' }] })
}

app.post('/api/chat', async (req, res) => {
  const { system, user, max_tokens, meta } = req.body
  const model = req.body.model || 'claude-sonnet-4-20250514'
  const isRouter = req.headers['x-delma-caller'] === 'router'
  const t0 = Date.now()

  // Best-effort: capture authenticated user for router-call logging.
  let authedUserId = null
  if (isRouter) {
    try { authedUserId = (await requireUser(req)).id } catch { /* unauthenticated chat is allowed */ }
  }

  if (model.startsWith('deepseek-')) {
    if (!process.env.DEEPSEEK_API_KEY) return res.status(500).json({ error: 'DEEPSEEK_API_KEY not set' })
    return callOpenAICompatible('https://api.deepseek.com/v1/chat/completions', process.env.DEEPSEEK_API_KEY, 'DeepSeek', model, system, user, max_tokens, res)
  }
  if (model.startsWith('gpt-') || model.startsWith('o1') || model.startsWith('o3')) {
    if (!process.env.OPENAI_API_KEY) return res.status(500).json({ error: 'OPENAI_API_KEY not set' })
    return callOpenAICompatible('https://api.openai.com/v1/chat/completions', process.env.OPENAI_API_KEY, 'OpenAI', model, system, user, max_tokens, res)
  }

  if (!process.env.ANTHROPIC_API_KEY) return res.status(500).json({ error: 'ANTHROPIC_API_KEY not set' })
  let response
  try {
    response = await fetch(ANTHROPIC_URL, {
      method: 'POST',
      headers: anthropicHeaders('web-router'),
      body: JSON.stringify({ model, max_tokens: max_tokens ?? 2000, system, messages: [{ role: 'user', content: user }] })
    })
  } catch (e) {
    return res.status(502).json({ error: 'Failed to reach Anthropic API: ' + e.message })
  }
  if (!response.ok) {
    const text = await response.text()
    return res.status(response.status).json({ error: text })
  }
  const body = await response.json()
  res.json(body)

  // Persist router calls for the Quality Lab. Fire-and-forget so the
  // response isn't blocked. Best-effort — failure here doesn't matter.
  if (isRouter && meta?.input) {
    const sb = getSb()
    if (sb) {
      const raw = body.content?.[0]?.text || ''
      let ops = []
      try { ops = extractJsonArrayServer(raw) } catch {}
      void sb.from('quality_router_calls').insert({
        user_id: authedUserId, workspace_id: meta.workspace_id || null,
        input: meta.input, ops, raw_response: raw, model,
        duration_ms: Date.now() - t0
      })
    }
  }
})

// Tiny mirror of src/extract-json-array.js for server use without requiring
// the browser bundle. Walks brackets, ignores trailing prose.
function extractJsonArrayServer(raw) {
  if (!raw) return []
  const start = raw.indexOf('[')
  if (start < 0) return []
  let depth = 0, inStr = false, esc = false
  for (let i = start; i < raw.length; i++) {
    const ch = raw[i]
    if (esc) { esc = false; continue }
    if (ch === '\\') { esc = true; continue }
    if (ch === '"') { inStr = !inStr; continue }
    if (inStr) continue
    if (ch === '[') depth++
    else if (ch === ']') { depth--; if (depth === 0) { try { return JSON.parse(raw.slice(start, i + 1)) } catch { return [] } } }
  }
  return []
}

// ── Supabase service-role client — lazy-initialized so missing env vars
//    on a deploy don't crash the whole server at boot. Endpoints that need
//    it call getSb() and bail out cleanly if env is incomplete.

let __sb = null
function getSb() {
  if (__sb) return __sb
  if (!process.env.SUPABASE_URL || !process.env.SUPABASE_SERVICE_ROLE_KEY) return null
  __sb = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY, {
    auth: { autoRefreshToken: false, persistSession: false }
  })
  return __sb
}

// Create org + membership via service role (bypasses RLS edge cases on client).
app.post('/api/create-org', async (req, res) => {
  const { name, userId } = req.body
  if (!name?.trim() || !userId) return res.status(400).json({ error: 'name and userId required' })
  console.log('[server] create-org:', name, 'for user', userId)

  const sb = getSb()
  if (!sb) return res.status(500).json({ error: 'Supabase not configured on server' })
  const slug = name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') + '-' + Date.now().toString(36)
  try {
    const { data: org, error } = await sb
      .from('organizations')
      .insert({ name: name.trim(), slug, created_by: userId })
      .select()
      .single()
    if (error) throw new Error(error.message)

    const { error: memberErr } = await sb
      .from('org_members')
      .insert({ org_id: org.id, user_id: userId, role: 'admin' })
    if (memberErr) throw new Error(memberErr.message)

    // Seed default org-level tabs (People + Playbook) so the new org has
    // its full tab set immediately.
    await sb.from('org_memory_notes').insert([
      {
        org_id: org.id,
        filename: 'people.md',
        content: '# People\n\nTeam members, roles, ownership.\n',
        permission: 'edit-all',
        owner_id: userId
      },
      {
        org_id: org.id,
        filename: 'playbook.md',
        content: '# General Patterns and Docs\n\nHow work happens here. Processes, approval paths, unwritten rules, timing gotchas.\n',
        permission: 'edit-all',
        owner_id: userId
      }
    ])

    console.log('[server] org created with People + Playbook seeded:', org.id)
    res.json({ ok: true, org })
  } catch (err) {
    console.error('[server] create-org failed:', err.message)
    res.status(500).json({ error: err.message })
  }
})

app.post('/api/refresh-claude-md', async (req, res) => {
  const sb = getSb()
  if (!sb) return res.status(500).json({ error: 'Supabase not configured on server' })
  let { workspaceId, userId } = req.body
  // If no workspaceId given, look up the user's active one
  if (!workspaceId && userId) {
    const { data: m } = await sb
      .from('org_members')
      .select('active_workspace_id')
      .eq('user_id', userId)
      .not('active_workspace_id', 'is', null)
      .limit(1)
      .single()
    workspaceId = m?.active_workspace_id
  }
  if (!workspaceId) return res.status(400).json({ error: 'workspaceId or userId required' })
  console.log('[server] refresh-claude-md for workspace:', workspaceId)
  const t0 = Date.now()

  try {
    const [{ data: views }, { data: memoryRows }, { data: ws }] = await Promise.all([
      sb.from('diagram_views').select('*').eq('workspace_id', workspaceId),
      sb.from('memory_notes').select('*').eq('workspace_id', workspaceId),
      sb.from('workspaces').select('name, org_id').eq('id', workspaceId).single()
    ])

    let orgName = ''
    if (ws?.org_id) {
      const { data: org } = await sb.from('organizations').select('name').eq('id', ws.org_id).single()
      orgName = org?.name || ''
    }

    const memoryMap = {}
    for (const row of memoryRows || []) memoryMap[row.filename] = row.content

    const claudeMd = await generateClaudeMd(views || [], memoryMap, orgName, ws?.name || '')
    const cwd = process.env.DELMA_PROJECT_DIR || process.cwd()
    await writeFile(resolve(cwd, 'CLAUDE.md'), claudeMd, 'utf-8')

    console.log('[server] CLAUDE.md refreshed in', Date.now() - t0, 'ms,', claudeMd.length, 'chars')
    res.json({ ok: true, length: claudeMd.length, ms: Date.now() - t0 })
  } catch (err) {
    console.error('[server] refresh failed:', err.message)
    res.status(500).json({ error: err.message })
  }
})

// ── Typed-op endpoint ─────────────────────────────────────────────────────────
// Body: { tabKey: "org:people.md" | "memory:decisions.md" | ...,
//         ops: [{ op, args }, ...], workspaceId, orgId }
// Auth: Authorization: Bearer <supabase_access_token>
// userId is taken from the verified token, NEVER from the request body.

app.post('/api/op', async (req, res) => {
  const sb = getSb()
  if (!sb) return res.status(500).json({ error: 'Supabase not configured' })
  let user
  try { user = await requireUser(req) }
  catch (err) { return res.status(err.status || 401).json({ error: err.message }) }

  const { tabKey, ops, workspaceId, orgId } = req.body || {}
  if (!tabKey || !Array.isArray(ops) || !ops.length) {
    return res.status(400).json({ error: 'tabKey and non-empty ops[] required' })
  }
  const scope = parseTabKey(tabKey, { workspaceId, orgId, userId: user.id })
  if (!scope) return res.status(400).json({ error: `not a structured tab: ${tabKey}` })

  // Authorize: the verified user must be a member of the relevant container.
  try {
    if (scope.kind === 'org') await requireOrgMembership(sb, user.id, orgId)
    else if (scope.kind === 'project' || scope.kind === 'diagram') await requireWorkspaceMembership(sb, user.id, workspaceId)
  } catch (err) { return res.status(err.status || 403).json({ error: err.message }) }

  console.log('[server] op:', tabKey, 'ops:', ops.map(o => o.op).join(','), 'by', user.id.slice(0, 8))
  const t0 = Date.now()
  try {
    const result = await applyOpsToTab(sb, scope, ops)
    console.log('[server] op applied — applied:', result.applied.length, 'errors:', result.errors.length)
    void sb.from('api_op_logs').insert({
      user_id: user.id, workspace_id: workspaceId, org_id: orgId,
      tab_key: tabKey, ops, applied_count: result.applied.length, error_count: result.errors.length,
      duration_ms: Date.now() - t0, success: true
    })
    res.json({ ok: true, ...result })
  } catch (err) {
    console.error('[server] op failed:', err.message)
    void sb.from('api_op_logs').insert({
      user_id: user.id, workspace_id: workspaceId, org_id: orgId,
      tab_key: tabKey, ops, duration_ms: Date.now() - t0, success: false, error: err.message
    })
    res.status(500).json({ error: err.message })
  }
})

// ── Structured-tab markdown save ──────────────────────────────────────────────
// When the user edits the markdown view of a structured tab and clicks Save,
// we parse the markdown back into structured JSON so the source of truth stays
// in sync. Without this, manual edits would be silently overwritten the next
// time the typed-op router or MCP tools touch the tab.
//
// Body: { tabKey, content, workspaceId, orgId }
// Auth: Authorization: Bearer <supabase_access_token>

app.post('/api/save-structured-tab', async (req, res) => {
  const sb = getSb()
  if (!sb) return res.status(500).json({ error: 'Supabase not configured' })
  let user
  try { user = await requireUser(req) }
  catch (err) { return res.status(err.status || 401).json({ error: err.message }) }

  const { tabKey, content, workspaceId, orgId } = req.body || {}
  if (!tabKey || typeof content !== 'string') {
    return res.status(400).json({ error: 'tabKey and content required' })
  }
  const [prefix, filename] = tabKey.split(':')
  if (!isStructuredTab(filename)) {
    return res.status(400).json({ error: `not a structured tab: ${tabKey}` })
  }

  try {
    if (prefix === 'org') await requireOrgMembership(sb, user.id, orgId)
    else if (prefix === 'memory') await requireWorkspaceMembership(sb, user.id, workspaceId)
    else return res.status(400).json({ error: `unknown tab prefix: ${prefix}` })
  } catch (err) { return res.status(err.status || 403).json({ error: err.message }) }

  console.log('[server] save-structured-tab:', tabKey, 'len:', content.length, 'by', user.id.slice(0, 8))

  let structured
  try {
    structured = await parseStructuredContent(filename, content, { anthropicKey: process.env.ANTHROPIC_API_KEY })
    if (!structured) return res.status(500).json({ error: `no parser for ${filename}` })
  } catch (err) {
    console.error('[server] parse failed:', err.message)
    return res.status(500).json({ error: `parse failed: ${err.message}` })
  }

  // Re-render from parsed JSON so the saved content matches the canonical view.
  const rendered = render(filename, structured)

  const table = prefix === 'org' ? 'org_memory_notes' : 'memory_notes'
  const filter = prefix === 'org'
    ? { org_id: orgId, filename }
    : { workspace_id: workspaceId, filename }

  // Upsert
  const { data: existing } = await sb.from(table).select('id').match(filter).maybeSingle()
  if (existing) {
    const { error } = await sb.from(table).update({ structured, content: rendered }).eq('id', existing.id)
    if (error) return res.status(500).json({ error: error.message })
  } else {
    const insertRow = prefix === 'org'
      ? { org_id: orgId, filename, structured, content: rendered, permission: 'edit-all', owner_id: user.id }
      : { workspace_id: workspaceId, filename, structured, content: rendered, visibility: 'shared', owner_id: user.id }
    const { error } = await sb.from(table).insert(insertRow)
    if (error) return res.status(500).json({ error: error.message })
  }
  res.json({ ok: true, structured, content: rendered })
})

// ── Quality Lab ──────────────────────────────────────────────────────────────
// Public observability page + manual triggers + overnight scheduler.

app.get('/logs', async (req, res) => {
  try {
    // /logs              → list of runs
    // /logs?run=<uuid>   → detail view for a specific run
    const runId = typeof req.query.run === 'string' ? req.query.run : null
    const html = await renderLogsPage(runId)
    res.set('Content-Type', 'text/html; charset=utf-8').send(html)
  } catch (err) {
    res.status(500).send(`<pre>logs render failed: ${err.message}</pre>`)
  }
})

// Conversation tick — fired by inject-claude-md.sh on every Claude Code
// UserPromptSubmit. Joining ticks to mcp_call_logs gives real Mode-A
// timeliness ("did Claude call the tool the same turn or N turns later").
// No auth — internal observability ping. Worst case someone spams ticks
// and we flag it as noise.
app.post('/api/conversation-tick', async (req, res) => {
  const sb = getSb()
  if (!sb) return res.status(500).json({ error: 'Supabase not configured' })
  const { workspace_id, user_id, source } = req.body || {}
  void sb.from('conversation_ticks').insert({
    workspace_id: workspace_id || null,
    user_id: user_id || null,
    source: source || 'inject-hook'
  })
  res.json({ ok: true })
})

// Manual triggers (no auth — internal use; remove if exposed externally)
app.post('/quality/run', async (req, res) => {
  res.json({ ok: true, started: true })
  void runAllLayers().catch(err => console.error('[quality] run failed:', err))
})
app.post('/quality/run-overnight', async (req, res) => {
  res.json({ ok: true, started: true })
  void runOvernight().catch(err => console.error('[quality] overnight run failed:', err))
})

// Scheduler: fire the overnight job once per night at 11:30pm America/Los_Angeles.
// Using Intl.DateTimeFormat handles DST automatically (PST in winter, PDT in
// summer) so we never drift by an hour twice a year.
let lastSimDate = null
const FIRE_AT_PT_HOUR = 0
const FIRE_AT_PT_MIN = 0

const PT_FORMATTER = new Intl.DateTimeFormat('en-US', {
  timeZone: 'America/Los_Angeles',
  year: 'numeric', month: '2-digit', day: '2-digit',
  hour: '2-digit', minute: '2-digit', hour12: false
})

function ptNow() {
  const parts = Object.fromEntries(PT_FORMATTER.formatToParts(new Date()).map(p => [p.type, p.value]))
  return { hour: parseInt(parts.hour, 10) % 24, min: parseInt(parts.minute, 10) }
}
function todayPTKey() {
  const parts = Object.fromEntries(PT_FORMATTER.formatToParts(new Date()).map(p => [p.type, p.value]))
  return `${parts.year}-${parts.month}-${parts.day}`
}
async function maybeRunOvernight() {
  if (!process.env.ANTHROPIC_API_KEY) return
  const { hour, min } = ptNow()
  // Fire window: 12:00am-12:04am PT (gives a 5-min margin if the minute tick is delayed)
  if (hour !== FIRE_AT_PT_HOUR || min < FIRE_AT_PT_MIN || min > FIRE_AT_PT_MIN + 4) return
  const key = todayPTKey()
  if (lastSimDate === key) return  // already ran tonight
  lastSimDate = key
  console.log(`[quality:sched] firing overnight runner at ${hour}:${String(min).padStart(2, '0')} PT`)
  try {
    await runOvernight()
  } catch (err) {
    console.error('[quality:sched] overnight run failed:', err)
  }
}
setInterval(maybeRunOvernight, 60 * 1000)  // tick every minute, no-op outside window

// ── Static Files (production) ────────────────────────────────────────────────

if (process.env.NODE_ENV === 'production') {
  const dist = join(__dirname, '../dist')
  app.use(express.static(dist))
  app.get('*', (req, res) => res.sendFile(join(dist, 'index.html')))
}

app.listen(PORT, () => console.log(`Delma server on http://localhost:${PORT}`))
