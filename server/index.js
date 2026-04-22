// Delma Express Server — simplified for Supabase backend
// Handles: static file serving (production) + chat proxy (AI API keys stay server-side)
// Auth, workspace CRUD, memory CRUD, real-time — all handled by Supabase directly from the client.

import express from 'express'
import { config } from 'dotenv'
import { fileURLToPath } from 'url'
import { dirname, join } from 'path'
import { createClient } from '@supabase/supabase-js'
import { applyOpsToTab, parseTabKey } from './lib/apply-op.js'
import { cleanMermaid } from './lib/clean-mermaid.js'
import { getSfmcAccountsForOrg } from './lib/sfmc-account.js'
import * as sfmcClient from './lib/sfmc-client.js'
import { assemble207, validate207 } from './lib/sfmc-email-assembly.js'
import { BLOCKS, BASE_TEMPLATE } from './email-library/index.js'
import { requireUser, requireOrgMembership, requireProjectMembership } from './lib/auth.js'
import { parseStructuredContent } from './lib/parse-tab.js'
import { render, isStructuredTab } from '../src/tab-ops.js'
import { runAllLayers, runOvernight } from './quality/runner.js'
import { renderLogsPage } from './quality/logs-page.js'
import { ANTHROPIC_URL, anthropicHeaders } from './lib/llm.js'
import { handleChatStream } from './chat/stream.js'
import { makeLimiter } from './lib/rate-limit.js'
import { encrypt } from './lib/crypto.js'
import { initLogStream, isLogStreamEnabled, attachSseClient } from './lib/log-stream.js'

// Install before anything else logs, so startup traces land in the ring buffer.
if (isLogStreamEnabled()) initLogStream()

// Per-user rate limits. Numbers tuned to be invisible to humans but stop
// a runaway loop or a malicious script from burning credits / spamming
// the DB. Tune if users start hitting them in normal use.
const chatLimiter = makeLimiter({ windowMs: 60_000, max: 20 })        // 20 chat msgs/min
const tickLimiter = makeLimiter({ windowMs: 60_000, max: 60 })        // 60 ticks/min
const MAX_CHAT_MESSAGE_BYTES = 50_000                                  // ~50KB per message

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

// ── Debug log stream ─────────────────────────────────────────────────────────
// SSE endpoint that mirrors server console output to any connected browser.
// Dev-only (gated by isLogStreamEnabled) + auth-required (don't leak internals).
app.get('/api/debug/logs', async (req, res) => {
  if (!isLogStreamEnabled()) return res.status(404).json({ error: 'disabled' })
  try { await requireUser(req) }
  catch (err) { return res.status(err.status || 401).json({ error: err.message }) }
  attachSseClient(res)
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
  // Require a valid session. This endpoint proxies to the LLM provider with
  // server-held API keys; unauthenticated access lets anyone burn credits.
  let authedUser
  try { authedUser = await requireUser(req) }
  catch (err) { return res.status(err.status || 401).json({ error: err.message }) }

  if (!chatLimiter.allow(authedUser.id)) {
    return res.status(429).json({ error: 'Too many chat requests, slow down.' })
  }

  const { system, user, max_tokens, meta } = req.body
  if (typeof user === 'string' && user.length > MAX_CHAT_MESSAGE_BYTES) {
    return res.status(413).json({ error: `Message too large (max ${MAX_CHAT_MESSAGE_BYTES} chars).` })
  }
  const model = req.body.model || 'claude-sonnet-4-20250514'
  const isRouter = req.headers['x-delma-caller'] === 'router'
  const t0 = Date.now()
  const authedUserId = authedUser.id

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
        user_id: authedUserId, project_id: meta.project_id || null,
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

// ── SFMC Connections ─────────────────────────────────────────────────────────
// Per-org SFMC API credentials. Encrypted in Node before insert (AES-256-GCM)
// and decrypted at runtime when the chat needs to call SFMC. Never returned
// to the browser in plaintext — GETs return only safe metadata (label, MID,
// last refresh, has-secret booleans).

function validBuRole(r) { return r === 'parent' || r === 'child' }

// GET /api/sfmc-accounts?orgId=… — returns ALL configured connections for the
// org as a `{ child: {...}, parent: {...} }` map. Safe metadata only — never
// returns the encrypted secrets.
app.get('/api/sfmc-accounts', async (req, res) => {
  let user
  try { user = await requireUser(req) }
  catch (err) { return res.status(err.status || 401).json({ error: err.message }) }
  const orgId = req.query.orgId
  if (!orgId) return res.status(400).json({ error: 'orgId required' })
  try { await requireOrgMembership(getSb(), user.id, orgId) }
  catch (err) { return res.status(err.status || 403).json({ error: err.message }) }

  const sb = getSb()
  const { data } = await sb.from('sfmc_accounts')
    .select('id, bu_role, account_label, auth_base_url, rest_base_url, soap_base_url, account_id, last_refresh_at, last_error, updated_at')
    .eq('org_id', orgId)
  const out = {}
  for (const row of data || []) {
    const role = row.bu_role || 'child'
    out[role] = {
      id: row.id,
      bu_role: role,
      label: row.account_label,
      auth_base_url: row.auth_base_url,
      rest_base_url: row.rest_base_url,
      soap_base_url: row.soap_base_url,
      mid: row.account_id,
      last_refresh_at: row.last_refresh_at,
      last_error: row.last_error,
      updated_at: row.updated_at
    }
  }
  res.json({ accounts: out })
})

// PUT /api/sfmc-account — upsert one (org, bu_role) row. Body:
//   orgId, bu_role ('parent' | 'child'), label, auth_base_url, rest_base_url,
//   soap_base_url, mid, client_id, client_secret
// Secrets are encrypted before insert.
app.put('/api/sfmc-account', async (req, res) => {
  let user
  try { user = await requireUser(req) }
  catch (err) { return res.status(err.status || 401).json({ error: err.message }) }

  const {
    orgId, bu_role, label, auth_base_url, rest_base_url, soap_base_url,
    mid, client_id, client_secret
  } = req.body || {}
  if (!orgId) return res.status(400).json({ error: 'orgId required' })
  if (!validBuRole(bu_role)) return res.status(400).json({ error: 'bu_role must be "parent" or "child"' })
  try { await requireOrgMembership(getSb(), user.id, orgId) }
  catch (err) { return res.status(err.status || 403).json({ error: err.message }) }
  if (!auth_base_url || !rest_base_url || !soap_base_url) {
    return res.status(400).json({ error: 'auth_base_url, rest_base_url, soap_base_url all required' })
  }
  if (!client_id || !client_secret) {
    return res.status(400).json({ error: 'client_id and client_secret required' })
  }

  const sb = getSb()
  const { data: existing } = await sb.from('sfmc_accounts')
    .select('id').eq('org_id', orgId).eq('bu_role', bu_role).maybeSingle()
  const row = {
    org_id: orgId,
    bu_role,
    connected_by: user.id,
    account_label: label || null,
    auth_base_url, rest_base_url, soap_base_url,
    is_sandbox: false,
    account_id: mid || null,
    client_id_enc: encrypt(client_id),
    client_secret_enc: encrypt(client_secret),
    updated_at: new Date().toISOString()
  }
  if (existing) {
    const { error } = await sb.from('sfmc_accounts').update(row).eq('id', existing.id)
    if (error) return res.status(500).json({ error: error.message })
  } else {
    const { error } = await sb.from('sfmc_accounts').insert(row)
    if (error) return res.status(500).json({ error: error.message })
  }
  res.json({ ok: true })
})

// DELETE /api/sfmc-account?orgId=…&buRole=parent|child — drop one connection.
app.delete('/api/sfmc-account', async (req, res) => {
  let user
  try { user = await requireUser(req) }
  catch (err) { return res.status(err.status || 401).json({ error: err.message }) }
  const orgId = req.query.orgId
  const buRole = req.query.buRole
  if (!orgId) return res.status(400).json({ error: 'orgId required' })
  if (!validBuRole(buRole)) return res.status(400).json({ error: 'buRole must be "parent" or "child"' })
  try { await requireOrgMembership(getSb(), user.id, orgId) }
  catch (err) { return res.status(err.status || 403).json({ error: err.message }) }
  const sb = getSb()
  await sb.from('sfmc_accounts').delete().eq('org_id', orgId).eq('bu_role', buRole)
  res.json({ ok: true })
})

// ── Connected Apps: per-project permissions ─────────────────────────────────
// Each integration (SFMC, etc.) has a per-project permission level:
//   - 'read_only'  → Delma can read from the app, never write
//   - 'read_write' → Delma can call mutating endpoints
// Connection status itself is derived from the app's own storage (SFMC →
// sfmc_accounts). The permissions table only carries the access level.
//
// SUPPORTED_APPS is the source of truth for which integrations exist today.
// Adding a new app = add an entry here and render logic picks it up.
const SUPPORTED_APPS = [
  {
    id: 'sfmc',
    name: 'Salesforce Marketing Cloud',
    description: 'Email sends, journeys, data extensions, content builder assets. Delma reads or edits your SFMC instance on your behalf.',
    supports_write: true
  }
]

async function getSfmcConnectionForProject(sb, projectId) {
  const { data: proj } = await sb.from('projects').select('org_id').eq('id', projectId).maybeSingle()
  if (!proj?.org_id) return { connected: false, last_sync_at: null }
  const { data: accts } = await sb.from('sfmc_accounts')
    .select('id, bu_role, last_refresh_at, updated_at')
    .eq('org_id', proj.org_id)
  if (!accts?.length) return { connected: false, last_sync_at: null }
  const latest = accts
    .map(a => a.last_refresh_at || a.updated_at)
    .filter(Boolean)
    .sort()
    .at(-1) || null
  return { connected: true, last_sync_at: latest, bu_roles: accts.map(a => a.bu_role) }
}

app.get('/api/projects/:projectId/app-permissions', async (req, res) => {
  const sb = getSb()
  let user
  try { user = await requireUser(req) }
  catch (err) { return res.status(err.status || 401).json({ error: err.message }) }
  const { projectId } = req.params
  try {
    try { await requireProjectMembership(sb, user.id, projectId) }
    catch {
      const { data: ws } = await sb.from('projects').select('org_id').eq('id', projectId).single()
      await requireOrgMembership(sb, user.id, ws.org_id)
    }
  } catch (err) { return res.status(err.status || 403).json({ error: err.message }) }

  const { data: rows } = await sb.from('project_app_permissions')
    .select('app_id, permission, updated_at')
    .eq('project_id', projectId)
  const permByApp = Object.fromEntries((rows || []).map(r => [r.app_id, r]))

  const apps = []
  for (const app of SUPPORTED_APPS) {
    let conn = { connected: false, last_sync_at: null }
    if (app.id === 'sfmc') conn = await getSfmcConnectionForProject(sb, projectId)
    apps.push({
      ...app,
      connected: conn.connected,
      last_sync_at: conn.last_sync_at,
      permission: permByApp[app.id]?.permission || 'read_only',
      permission_updated_at: permByApp[app.id]?.updated_at || null
    })
  }
  res.json({ apps })
})

app.put('/api/projects/:projectId/app-permissions/:appId', async (req, res) => {
  const sb = getSb()
  let user
  try { user = await requireUser(req) }
  catch (err) { return res.status(err.status || 401).json({ error: err.message }) }
  const { projectId, appId } = req.params
  const { permission } = req.body || {}

  const appSpec = SUPPORTED_APPS.find(a => a.id === appId)
  if (!appSpec) return res.status(404).json({ error: 'unknown app' })
  if (!['read_only', 'read_write'].includes(permission)) {
    return res.status(400).json({ error: 'permission must be read_only or read_write' })
  }
  if (permission === 'read_write' && !appSpec.supports_write) {
    return res.status(400).json({ error: `${appSpec.name} does not support write operations` })
  }

  try {
    try { await requireProjectMembership(sb, user.id, projectId) }
    catch {
      const { data: ws } = await sb.from('projects').select('org_id').eq('id', projectId).single()
      await requireOrgMembership(sb, user.id, ws.org_id)
    }
  } catch (err) { return res.status(err.status || 403).json({ error: err.message }) }

  const { error } = await sb.from('project_app_permissions').upsert({
    project_id: projectId,
    app_id: appId,
    permission,
    updated_at: new Date().toISOString(),
    updated_by: user.id
  }, { onConflict: 'project_id,app_id' })
  if (error) return res.status(500).json({ error: error.message })
  console.log('[delma WRITE] app_permission', appId, '→', permission, 'project:', projectId.slice(0, 8), 'by:', user.id.slice(0, 8))
  res.json({ ok: true, permission })
})

// ── Email library manifest ────────────────────────────────────────────────────
// Returns the static block library + base template metadata for the
// "New Email" modal. Live fetches of folder trees and template IDs happen
// via separate SFMC endpoints. Auth required so external callers can't
// enumerate block HTML without a session.

app.get('/api/email-library', async (req, res) => {
  try { await requireUser(req) }
  catch (err) { return res.status(err.status || 401).json({ error: err.message }) }

  res.json({
    baseTemplate: {
      id: BASE_TEMPLATE.id,
      name: BASE_TEMPLATE.name,
      description: BASE_TEMPLATE.description,
      slots: BASE_TEMPLATE.slots
    },
    blocks: BLOCKS.map(b => ({
      id: b.id,
      name: b.name,
      description: b.description,
      variables: b.variables,
      html: b.html // used by the modal to render thumbnail previews
    }))
  })
})

// ── Create Email asset ────────────────────────────────────────────────────────
// Called by the "New Email" modal when the user hits Create. Assembles the
// 207 JSON via the assembly module, validates, POSTs to SFMC, returns the
// new asset ID + Content Builder deep link.

app.post('/api/projects/:projectId/emails/create', async (req, res) => {
  const sb = getSb()
  if (!sb) return res.status(500).json({ error: 'Supabase not configured' })
  let user
  try { user = await requireUser(req) }
  catch (err) { return res.status(err.status || 401).json({ error: err.message }) }

  const { projectId } = req.params
  try { await requireProjectMembership(sb, user.id, projectId) }
  catch (err) { return res.status(err.status || 403).json({ error: err.message }) }

  const { name, customerKey, subject, preheader, categoryId, templateKey, blocks, bu } = req.body || {}
  if (!name || !subject || !categoryId || !Array.isArray(blocks) || !blocks.length) {
    return res.status(400).json({ error: 'name, subject, categoryId, blocks[] all required' })
  }
  const resolvedTemplateKey = templateKey || BASE_TEMPLATE.id

  const { data: ws } = await sb.from('projects').select('org_id').eq('id', projectId).single()
  if (!ws?.org_id) return res.status(404).json({ error: 'project not found' })
  const accounts = await getSfmcAccountsForOrg(ws.org_id)
  const acct = accounts[bu || 'child'] || accounts.child || accounts.parent
  if (!acct) return res.status(400).json({ error: 'no SFMC account connected for this org' })

  // Resolve templateKey → SFMC template asset ID (cached per account inside sfmc-client).
  let templateId
  try {
    const tokenRes = await fetch(`${acct.auth_base_url}/v2/token`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        grant_type: 'client_credentials',
        client_id: acct.client_id,
        client_secret: acct.client_secret,
        ...(acct.account_id ? { account_id: acct.account_id } : {})
      })
    })
    const token = (await tokenRes.json()).access_token
    const lookup = await fetch(`${acct.rest_base_url}/asset/v1/content/assets/query`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ query: { property: 'customerKey', simpleOperator: 'equals', value: resolvedTemplateKey } })
    })
    const ld = await lookup.json()
    templateId = ld.items?.[0]?.id
  } catch (err) {
    return res.status(502).json({ error: `template lookup failed: ${err.message}` })
  }
  if (!templateId) return res.status(400).json({ error: `template "${resolvedTemplateKey}" not found in SFMC — run scripts/upload-base-template.js to install it` })

  let payload
  try { payload = assemble207({ name, customerKey, subject, preheader, categoryId, templateId, blocks }) }
  catch (err) { return res.status(400).json({ error: `assembly failed: ${err.message}` }) }

  const validation = validate207(payload)
  if (!validation.ok) {
    console.error('[server] create-email validation failed:', validation.errors)
    return res.status(400).json({ error: `validation failed`, details: validation.errors })
  }

  console.log('[server] create-email POST → SFMC — project:', projectId.slice(0, 8), 'name:', name, 'blocks:', blocks.map(b => b.id).join(','))
  const result = await sfmcClient.createEmailAsset(acct, payload)
  if (!result.ok) {
    console.error('[server] create-email SFMC rejected:', result.code, result.message)
    return res.status(502).json({ error: result.message, code: result.code })
  }
  console.log('[server] create-email success — assetId:', result.assetId, 'customerKey:', result.customerKey)
  res.json({
    ok: true,
    assetId: result.assetId,
    customerKey: result.customerKey,
    name: result.name,
    deepLink: `${acct.rest_base_url?.replace(/\.rest\.marketingcloudapis\.com.*$/, '').replace(/^https?:\/\//, 'https://mc.')}.exacttarget.com/cloud/#app/Content%20Builder/${result.assetId}`
  })
})

// ── SFMC folder tree (for the modal's folder picker) ──────────────────────────
// Returns content-builder email folders so the user can pick where the
// new email lands. `catType=asset` filters to Content Builder folders.

app.get('/api/projects/:projectId/sfmc/folders', async (req, res) => {
  const sb = getSb()
  if (!sb) return res.status(500).json({ error: 'Supabase not configured' })
  let user
  try { user = await requireUser(req) }
  catch (err) { return res.status(err.status || 401).json({ error: err.message }) }

  const { projectId } = req.params
  try { await requireProjectMembership(sb, user.id, projectId) }
  catch (err) { return res.status(err.status || 403).json({ error: err.message }) }

  const { data: ws } = await sb.from('projects').select('org_id').eq('id', projectId).single()
  if (!ws?.org_id) return res.status(404).json({ error: 'project not found' })
  const accounts = await getSfmcAccountsForOrg(ws.org_id)
  const acct = accounts.child || accounts.parent
  if (!acct) return res.status(400).json({ error: 'no SFMC account connected' })

  try {
    const tokenRes = await fetch(`${acct.auth_base_url}/v2/token`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        grant_type: 'client_credentials',
        client_id: acct.client_id,
        client_secret: acct.client_secret,
        ...(acct.account_id ? { account_id: acct.account_id } : {})
      })
    })
    const token = (await tokenRes.json()).access_token
    const folderRes = await fetch(`${acct.rest_base_url}/asset/v1/content/categories?$pagesize=200`, {
      headers: { Authorization: `Bearer ${token}` }
    })
    const data = await folderRes.json()
    const items = (data.items || []).map(c => ({ id: c.id, name: c.name, parentId: c.parentId, path: c.categoryType }))
    res.json({ ok: true, folders: items })
  } catch (err) {
    res.status(502).json({ error: err.message })
  }
})

// ── Clean diagrams ────────────────────────────────────────────────────────────
// Re-runs the mermaid post-processor over every diagram row in a project.
// Useful when rows were written before the post-processor existed, or when
// the model emits duplicate classDef / class statements that slipped through.
// Non-destructive: only touches rows whose mermaid changes under cleanup.

app.post('/api/projects/:projectId/clean-diagrams', async (req, res) => {
  const sb = getSb()
  if (!sb) return res.status(500).json({ error: 'Supabase not configured' })
  let user
  try { user = await requireUser(req) }
  catch (err) { return res.status(err.status || 401).json({ error: err.message }) }

  const { projectId } = req.params
  try { await requireProjectMembership(sb, user.id, projectId) }
  catch (err) { return res.status(err.status || 403).json({ error: err.message }) }

  console.log('[server] clean-diagrams start — project:', projectId.slice(0, 8), 'user:', user.id.slice(0, 8))
  const { data: rows, error } = await sb
    .from('diagram_views')
    .select('id, view_key, mermaid')
    .eq('project_id', projectId)
  if (error) return res.status(500).json({ error: error.message })

  const touched = []
  for (const row of rows || []) {
    if (typeof row.mermaid !== 'string' || !row.mermaid.trim()) continue
    const cleaned = cleanMermaid(row.mermaid)
    if (cleaned === row.mermaid) {
      console.log('[server] clean-diagrams  ·', row.view_key, '— already clean')
      continue
    }
    const { error: updErr } = await sb.from('diagram_views').update({ mermaid: cleaned }).eq('id', row.id)
    if (updErr) return res.status(500).json({ error: updErr.message, viewKey: row.view_key })
    console.log('[server] clean-diagrams  ·', row.view_key, '— trimmed', row.mermaid.length - cleaned.length, 'chars (', row.mermaid.length, '→', cleaned.length, ')')
    touched.push({ viewKey: row.view_key, before: row.mermaid.length, after: cleaned.length })
  }

  console.log('[server] clean-diagrams done — project:', projectId.slice(0, 8), 'scanned:', rows?.length || 0, 'cleaned:', touched.length)
  res.json({ ok: true, scanned: rows?.length || 0, cleaned: touched.length, views: touched })
})

// ── Typed-op endpoint ─────────────────────────────────────────────────────────
// Body: { tabKey: "org:people.md" | "memory:decisions.md" | ...,
//         ops: [{ op, args }, ...], projectId, orgId }
// Auth: Authorization: Bearer <supabase_access_token>
// userId is taken from the verified token, NEVER from the request body.

app.post('/api/op', async (req, res) => {
  const sb = getSb()
  if (!sb) return res.status(500).json({ error: 'Supabase not configured' })
  let user
  try { user = await requireUser(req) }
  catch (err) { return res.status(err.status || 401).json({ error: err.message }) }

  const { tabKey, ops, projectId, orgId } = req.body || {}
  if (!tabKey || !Array.isArray(ops) || !ops.length) {
    return res.status(400).json({ error: 'tabKey and non-empty ops[] required' })
  }
  const scope = parseTabKey(tabKey, { projectId, orgId, userId: user.id })
  if (!scope) return res.status(400).json({ error: `not a structured tab: ${tabKey}` })

  // Authorize: the verified user must be a member of the relevant container.
  try {
    if (scope.kind === 'org') await requireOrgMembership(sb, user.id, orgId)
    else if (scope.kind === 'project' || scope.kind === 'diagram') await requireProjectMembership(sb, user.id, projectId)
  } catch (err) { return res.status(err.status || 403).json({ error: err.message }) }

  console.log('[server] op:', tabKey, 'ops:', ops.map(o => o.op).join(','), 'by', user.id.slice(0, 8))
  const t0 = Date.now()
  try {
    const result = await applyOpsToTab(sb, scope, ops)
    console.log('[server] op applied — applied:', result.applied.length, 'errors:', result.errors.length)
    void sb.from('api_op_logs').insert({
      user_id: user.id, project_id: projectId, org_id: orgId,
      tab_key: tabKey, ops, applied_count: result.applied.length, error_count: result.errors.length,
      duration_ms: Date.now() - t0, success: true
    })
    res.json({ ok: true, ...result })
  } catch (err) {
    console.error('[server] op failed:', err.message)
    void sb.from('api_op_logs').insert({
      user_id: user.id, project_id: projectId, org_id: orgId,
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
// Body: { tabKey, content, projectId, orgId }
// Auth: Authorization: Bearer <supabase_access_token>

app.post('/api/save-structured-tab', async (req, res) => {
  const sb = getSb()
  if (!sb) return res.status(500).json({ error: 'Supabase not configured' })
  let user
  try { user = await requireUser(req) }
  catch (err) { return res.status(err.status || 401).json({ error: err.message }) }

  const { tabKey, content, projectId, orgId, expectedUpdatedAt, force } = req.body || {}
  if (!tabKey || typeof content !== 'string') {
    return res.status(400).json({ error: 'tabKey and content required' })
  }
  const [prefix, filename] = tabKey.split(':')
  if (!isStructuredTab(filename)) {
    return res.status(400).json({ error: `not a structured tab: ${tabKey}` })
  }

  try {
    if (prefix === 'org') await requireOrgMembership(sb, user.id, orgId)
    else if (prefix === 'memory') await requireProjectMembership(sb, user.id, projectId)
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
    : { project_id: projectId, filename }

  // Upsert. If the client gave us the timestamp it loaded, compare against
  // the current row's updated_at. If someone else saved since, refuse unless
  // the client explicitly sets `force` after reviewing the diff.
  const { data: existing } = await sb.from(table).select('id, updated_at, content').match(filter).maybeSingle()
  if (existing && expectedUpdatedAt && !force) {
    const serverTs = new Date(existing.updated_at).getTime()
    const clientTs = new Date(expectedUpdatedAt).getTime()
    if (Number.isFinite(serverTs) && Number.isFinite(clientTs) && serverTs - clientTs > 1000) {
      return res.status(409).json({
        error: 'conflict',
        serverContent: existing.content,
        serverUpdatedAt: existing.updated_at
      })
    }
  }
  if (existing) {
    const { error } = await sb.from(table).update({ structured, content: rendered }).eq('id', existing.id)
    if (error) return res.status(500).json({ error: error.message })
  } else {
    const insertRow = prefix === 'org'
      ? { org_id: orgId, filename, structured, content: rendered, permission: 'edit-all', owner_id: user.id }
      : { project_id: projectId, filename, structured, content: rendered, visibility: 'shared', owner_id: user.id }
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
  // Called fire-and-forget from the Claude Code CLI hook (dev-only analytics).
  // No JWT because the hook doesn't have one. Rate-limit by client IP so
  // a loop can't fill the table. If this ever leaves dev, add real auth.
  const ip = req.ip || req.socket?.remoteAddress || 'unknown'
  if (!tickLimiter.allow(ip)) return res.status(429).json({ error: 'rate limited' })

  const sb = getSb()
  if (!sb) return res.status(500).json({ error: 'Supabase not configured' })
  const { project_id, user_id, source } = req.body || {}
  void sb.from('conversation_ticks').insert({
    project_id: project_id || null,
    user_id: user_id || null,
    source: source || 'inject-hook'
  })
  res.json({ ok: true })
})

// Manual triggers (no auth — internal use; remove if exposed externally)
// In-app chat: Claude Agent SDK running server-side, streaming via SSE.
// This is the primary chat surface (replaces the need for Claude Desktop).
app.post('/api/chat/stream', handleChatStream)

// GET /api/chat/history?projectId=… — last N messages for the user's active
// conversation in this project. Used on UI mount so reload doesn't blank the
// chat. Filters strictly by (user_id from JWT, project_id, archived=false)
// so users only ever see their own private conversation.
app.get('/api/chat/history', async (req, res) => {
  let user
  try { user = await requireUser(req) }
  catch (err) { return res.status(err.status || 401).json({ error: err.message }) }

  const projectId = req.query.projectId
  if (!projectId) return res.status(400).json({ error: 'projectId required' })
  const limit = Math.min(parseInt(req.query.limit) || 100, 500)

  const sb = getSb()
  if (!sb) return res.status(500).json({ error: 'Supabase not configured' })

  // Membership check — user must belong to project or its parent org.
  try {
    const { data: ws } = await sb.from('projects').select('org_id').eq('id', projectId).single()
    if (!ws) return res.status(404).json({ error: 'project not found' })
    try { await requireProjectMembership(sb, user.id, projectId) }
    catch { await requireOrgMembership(sb, user.id, ws.org_id) }
  } catch (err) { return res.status(err.status || 403).json({ error: err.message }) }

  // Active conversation for this (user, project).
  const { data: conv } = await sb
    .from('conversations')
    .select('id, created_at, updated_at')
    .eq('project_id', projectId)
    .eq('user_id', user.id)
    .eq('archived', false)
    .order('updated_at', { ascending: false })
    .limit(1)
    .maybeSingle()

  if (!conv) return res.json({ conversationId: null, messages: [] })

  // Pull last N messages, oldest first so the UI renders in order.
  const { data: rows } = await sb
    .from('messages')
    .select('id, role, content, tool_calls, tool_name, created_at')
    .eq('conversation_id', conv.id)
    .order('id', { ascending: false })
    .limit(limit)

  const messages = (rows || []).reverse()
  res.json({ conversationId: conv.id, messages })
})

// POST /api/chat/clear — archive the current active conversation for the
// (user, project) pair. Non-destructive: history stays in the DB, future
// `/api/chat/history` calls just won't find it (archived=true filter), and
// the next message creates a fresh conversation.
app.post('/api/chat/clear', async (req, res) => {
  let user
  try { user = await requireUser(req) }
  catch (err) { return res.status(err.status || 401).json({ error: err.message }) }

  const { projectId } = req.body || {}
  if (!projectId) return res.status(400).json({ error: 'projectId required' })

  const sb = getSb()
  try {
    const { data: ws } = await sb.from('projects').select('org_id').eq('id', projectId).single()
    if (!ws) return res.status(404).json({ error: 'project not found' })
    try { await requireProjectMembership(sb, user.id, projectId) }
    catch { await requireOrgMembership(sb, user.id, ws.org_id) }
  } catch (err) { return res.status(err.status || 403).json({ error: err.message }) }

  const { error } = await sb.from('conversations')
    .update({ archived: true })
    .eq('project_id', projectId)
    .eq('user_id', user.id)
    .eq('archived', false)
  if (error) return res.status(500).json({ error: error.message })
  console.log('[delma WRITE] chat_clear project:', projectId.slice(0, 8), 'user:', user.id.slice(0, 8))
  res.json({ ok: true })
})

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
