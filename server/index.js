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

// ── Refresh CLAUDE.md on demand (called by web app after Save) ──────────────
// Closes the bidirectional sync gap: web edits → file refresh → next message
// Claude sends will see fresh state via UserPromptSubmit hook.

const sb = createClient(process.env.SUPABASE_URL || '', process.env.SUPABASE_SERVICE_ROLE_KEY || '', {
  auth: { autoRefreshToken: false, persistSession: false }
})

// Create org + membership via service role (bypasses RLS edge cases on client).
app.post('/api/create-org', async (req, res) => {
  const { name, userId } = req.body
  if (!name?.trim() || !userId) return res.status(400).json({ error: 'name and userId required' })
  console.log('[server] create-org:', name, 'for user', userId)

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

    console.log('[server] org created:', org.id)
    res.json({ ok: true, org })
  } catch (err) {
    console.error('[server] create-org failed:', err.message)
    res.status(500).json({ error: err.message })
  }
})

app.post('/api/refresh-claude-md', async (req, res) => {
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

// ── Static Files (production) ────────────────────────────────────────────────

if (process.env.NODE_ENV === 'production') {
  const dist = join(__dirname, '../dist')
  app.use(express.static(dist))
  app.get('*', (req, res) => res.sendFile(join(dist, 'index.html')))
}

app.listen(PORT, () => console.log(`Delma server on http://localhost:${PORT}`))
