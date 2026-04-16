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
  const { system, user, max_tokens } = req.body
  const model = req.body.model || 'claude-sonnet-4-20250514'

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
    response = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': process.env.ANTHROPIC_API_KEY,
        'anthropic-version': '2023-06-01'
      },
      body: JSON.stringify({ model, max_tokens: max_tokens ?? 2000, system, messages: [{ role: 'user', content: user }] })
    })
  } catch (e) {
    return res.status(502).json({ error: 'Failed to reach Anthropic API: ' + e.message })
  }
  if (!response.ok) {
    const text = await response.text()
    return res.status(response.status).json({ error: text })
  }
  res.json(await response.json())
})

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
    else if (scope.kind === 'project') await requireWorkspaceMembership(sb, user.id, workspaceId)
  } catch (err) { return res.status(err.status || 403).json({ error: err.message }) }

  console.log('[server] op:', tabKey, 'ops:', ops.map(o => o.op).join(','), 'by', user.id.slice(0, 8))
  try {
    const result = await applyOpsToTab(sb, scope, ops)
    console.log('[server] op applied — applied:', result.applied.length, 'errors:', result.errors.length)
    res.json({ ok: true, ...result })
  } catch (err) {
    console.error('[server] op failed:', err.message)
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

// ── Static Files (production) ────────────────────────────────────────────────

if (process.env.NODE_ENV === 'production') {
  const dist = join(__dirname, '../dist')
  app.use(express.static(dist))
  app.get('*', (req, res) => res.sendFile(join(dist, 'index.html')))
}

app.listen(PORT, () => console.log(`Delma server on http://localhost:${PORT}`))
