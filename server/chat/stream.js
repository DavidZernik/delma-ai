// Delma's in-app chat — Claude Agent SDK running server-side, streaming to
// the browser via SSE. Claude's actual brain (same as Claude Code): default
// tools (Bash, Read, Write, Edit, Glob, Grep) PLUS Delma's typed ops via
// the internal MCP server.
//
// Each workspace gets its own scratch directory where Claude writes/reads
// files. SFMC creds and other env vars are available to Claude's bash
// (same trust model as Claude Code on a laptop — v1 runs unsandboxed, fine
// for our own use; enterprise sandboxing is a later phase).
//
// Persistence: every user message + assistant message + tool call is saved
// to the `messages` table for replay, history, and the quality lab.

import { query } from '@anthropic-ai/claude-agent-sdk'
import { mkdirSync, existsSync } from 'node:fs'
import { join } from 'node:path'
import { supabase as sb } from '../lib/supabase.js'
import { requireUser, requireOrgMembership, requireProjectMembership } from '../lib/auth.js'
import { makeLimiter } from '../lib/rate-limit.js'
import { loadSfmcAccounts } from '../lib/local-config.js'
import { buildChatSystemPrompt } from './context.js'
import { applyOpsToTab, parseTabKey } from '../lib/apply-op.js'

// Shared with /api/chat conceptually but separate bucket: the streaming
// endpoint is where the real LLM spend happens, so its budget is its own.
const streamLimiter = makeLimiter({ windowMs: 60_000, max: 15 })
const MAX_MESSAGE_BYTES = 50_000

const SCRATCH_ROOT = process.env.DELMA_SCRATCH_ROOT || '/tmp/delma'
const DEFAULT_MODEL = process.env.DELMA_CHAT_MODEL || 'claude-sonnet-4-5'

// Two-tier scratch layout:
//   /tmp/delma/orgs/{orgId}/shared/              ← reusable across projects
//   /tmp/delma/orgs/{orgId}/projects/{pid}/      ← project-specific
//   /tmp/delma/no-org/projects/{pid}/            ← orgless fallback, no shared
//
// Agent SDK cwd = project dir (primary workspace), and we pass the shared
// dir as an additional allowed directory so Claude can read/write reusable
// scripts there. Same-org API creds work in either dir, so a fetch script
// written once can be grabbed and reused by any project in the org.
function ensureScratchDirs(projectId, orgId) {
  if (orgId) {
    const orgRoot = join(SCRATCH_ROOT, 'orgs', orgId)
    const shared = join(orgRoot, 'shared')
    const project = join(orgRoot, 'projects', projectId)
    for (const d of [shared, project]) if (!existsSync(d)) mkdirSync(d, { recursive: true })
    return { projectDir: project, sharedDir: shared }
  }
  const project = join(SCRATCH_ROOT, 'no-org', 'projects', projectId)
  if (!existsSync(project)) mkdirSync(project, { recursive: true })
  return { projectDir: project, sharedDir: null }
}

// The Delma MCP server is started as a subprocess by Agent SDK. It exposes
// all of Delma's typed ops (add_person, add_decision, add_node, ...) as
// MCP tools, scoped to this user+workspace via env vars.
function delmaMcpConfig({ userId, projectId, sfmcAccounts }) {
  return {
    delma: {
      type: 'stdio',
      command: 'node',
      args: [join(process.cwd(), 'server', 'mcp.js')],
      env: {
        ...process.env,
        DELMA_USER_ID: userId,
        DELMA_PROJECT_ID: projectId,
        ...sfmcEnvVars(sfmcAccounts)
      }
    }
  }
}

// Translate the decrypted SFMC accounts map ({ child, parent }) into the
// env vars every all-salesforce-projects script expects:
//   - Child BU is the default (CLIENT_ID, CLIENT_SECRET, SFMC_SUBDOMAIN, MID)
//     because most projects send/build journeys via the child.
//   - Parent BU is exposed under PARENT_BU_* names (matches calendar-project).
// Per-turn injection — never written to disk.
function sfmcEnvVars(accounts) {
  if (!accounts) return {}
  const out = {}
  const child = accounts.child
  const parent = accounts.parent

  if (child) {
    Object.assign(out, {
      CLIENT_ID: child.client_id || '',
      CLIENT_SECRET: child.client_secret || '',
      SFMC_SUBDOMAIN: subdomainFromUrl(child.rest_base_url) || '',
      SFMC_MID: child.account_id || '',
      SFMC_AUTH_BASE_URL: child.auth_base_url || '',
      SFMC_REST_BASE_URL: child.rest_base_url || '',
      SFMC_SOAP_BASE_URL: child.soap_base_url || ''
    })
  }
  if (parent) {
    Object.assign(out, {
      PARENT_BU_CLIENT_ID: parent.client_id || '',
      PARENT_BU_CLIENT_SECRET: parent.client_secret || '',
      PARENT_BU_MID: parent.account_id || '',
      PARENT_BU_AUTH_BASE_URL: parent.auth_base_url || '',
      PARENT_BU_REST_BASE_URL: parent.rest_base_url || '',
      PARENT_BU_SOAP_BASE_URL: parent.soap_base_url || ''
    })
  }
  return out
}

function subdomainFromUrl(url) {
  const m = (url || '').match(/^https?:\/\/([^.]+)\./)
  return m ? m[1] : ''
}

// Or-create the single active conversation for this (user, project). One
// per person per project — David's chat about the Birthday Campaign is
// separate from Keyona's chat about the same project.
async function getOrCreateConversation(projectId, userId) {
  const { data: existing } = await sb
    .from('conversations')
    .select('id')
    .eq('project_id', projectId)
    .eq('user_id', userId)
    .eq('archived', false)
    .order('updated_at', { ascending: false })
    .limit(1)
    .maybeSingle()
  if (existing) return existing.id

  const { data: created, error } = await sb
    .from('conversations')
    .insert({ project_id: projectId, user_id: userId, title: null })
    .select('id')
    .single()
  if (error) throw new Error(`conversation create failed: ${error.message}`)
  return created.id
}

// Persist a single message to Supabase. Called from the streaming loop as
// each Agent SDK message lands.
//
// SDK message shapes we care about:
//   { type: 'assistant', message: { role: 'assistant', content: [{type:'text',text}, {type:'tool_use',id,name,input}, ...] } }
//   { type: 'user',      message: { role: 'user', content: [{type:'tool_result',tool_use_id,content}, ...] } }
//   { role: 'user', content: string }        — our own saveMessage call on user turn
// Plus meta types (system, result, partial, etc.) we don't persist.
//
// We normalize into two columns: role + content (text extracted), and
// tool_calls (array of {id,name,input}) when the assistant used tools this turn.
async function saveMessage(conversationId, message) {
  // Case A: we manually constructed { role, content } (user's own turn).
  if (message && typeof message === 'object' && 'role' in message && !('type' in message)) {
    await sb.from('messages').insert({
      conversation_id: conversationId,
      role: message.role,
      content: typeof message.content === 'string' ? message.content : JSON.stringify(message.content),
      tool_calls: null, tool_call_id: null, tool_name: null,
      tokens_in: null, tokens_out: null, model: null
    })
    return
  }

  // Case B: SDK messages — only persist the shapes that carry chat content.
  if (!message || typeof message !== 'object') return
  const t = message.type

  if (t === 'assistant' && message.message) {
    const blocks = Array.isArray(message.message.content) ? message.message.content : []
    const textParts = blocks.filter(b => b?.type === 'text').map(b => b.text || '')
    const toolUses = blocks.filter(b => b?.type === 'tool_use').map(b => ({ id: b.id, name: b.name, input: b.input }))
    const text = textParts.join('')
    // Skip empty frames — SDK emits many partial/tool-only assistant messages.
    if (!text.trim() && toolUses.length === 0) return
    await sb.from('messages').insert({
      conversation_id: conversationId,
      role: 'assistant',
      content: text,
      tool_calls: toolUses.length ? toolUses : null,
      tool_call_id: null,
      tool_name: null,
      tokens_in: message.message.usage?.input_tokens || null,
      tokens_out: message.message.usage?.output_tokens || null,
      model: message.message.model || null
    })
    return
  }

  if (t === 'user' && message.message) {
    // User messages from the SDK are tool results (role=user in the Anthropic
    // protocol). We save them as role='tool' for clearer history rendering.
    const blocks = Array.isArray(message.message.content) ? message.message.content : []
    const toolResults = blocks.filter(b => b?.type === 'tool_result').map(b => ({
      tool_use_id: b.tool_use_id,
      output: typeof b.content === 'string' ? b.content : JSON.stringify(b.content)
    }))
    if (!toolResults.length) return
    await sb.from('messages').insert({
      conversation_id: conversationId,
      role: 'tool',
      content: JSON.stringify(toolResults),
      tool_calls: null,
      tool_call_id: toolResults[0].tool_use_id || null,
      tool_name: null,
      tokens_in: null, tokens_out: null, model: null
    })
    return
  }

  // Other SDK types (system, result, partial_assistant, etc.): ignore.
}

// Rough translator from Agent SDK messages to what assistant-ui expects.
// Detect when a tool call is going to write to the scratchpad. Returns a
// short description of what's being written, or null if it's not a write.
// Catches Write/Edit directly, and the common Bash shell-redirect patterns
// (`>`, `>>`, `tee`, heredocs to files). Doesn't try to parse every possible
// shell form — just enough to see the pattern in logs.
function detectScratchWrite(toolName, input) {
  if (!input) return null
  if (toolName === 'Write' || toolName === 'Edit') {
    return `${toolName} ${input.file_path || '?'}`
  }
  if (toolName === 'Bash' && typeof input.command === 'string') {
    const cmd = input.command
    if (/(^|\s|\|)\s*(tee|dd)\s/.test(cmd)) return `Bash (tee/dd): ${cmd.slice(0, 80)}`
    if (/>>?\s*[^|&]/.test(cmd) && !/>\s*\/dev\/null/.test(cmd)) return `Bash redirect: ${cmd.slice(0, 80)}`
  }
  return null
}

// Agent SDK streams typed messages (user, assistant, tool_use, tool_result,
// etc.); we forward them as SSE events the client can render directly.
function sseEvent(res, event, data) {
  res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`)
}

// ── Suggestion registry ──────────────────────────────────────────────────────
// After the agent finishes a turn, the server scans its full assistant text
// for a <delma-suggest>[{tab, summary, tool, input}, ...]</delma-suggest>
// block. Each entry gets a fresh id, is parked here, and is streamed to the
// browser as a `suggestions` SSE event. The browser renders a button per
// entry: "Update Project Details with: <summary>?". On click, it POSTs
// /api/chat/apply-suggestion → we run the MCP tool against the user's
// workspace and write to Supabase. Memory lives only for the life of the
// server process — that's fine; the SSE event has all the data the client
// needs to display buttons and to re-POST if the server restarts.
const pendingSuggestions = new Map() // key: `${userId}:${id}` → suggestion

// Pull the last <delma-suggest>...</delma-suggest> JSON array out of the
// accumulated assistant text. Tolerant: allow surrounding whitespace, code
// fences the model may wrap around it, and partial parses (bad entries are
// dropped rather than failing the whole set).
function parseSuggestions(text) {
  if (!text) return []
  const m = text.match(/<delma-suggest>([\s\S]*?)<\/delma-suggest>/i)
  if (!m) return []
  const body = m[1].trim().replace(/^```(?:json)?/i, '').replace(/```$/, '').trim()
  let parsed
  try { parsed = JSON.parse(body) } catch { return [] }
  if (!Array.isArray(parsed)) return []
  const ALLOWED_TABS = new Set(['Project Details', 'General Patterns and Docs', 'People'])
  return parsed.filter(s =>
    s && typeof s === 'object'
    && ALLOWED_TABS.has(s.tab)
    && typeof s.summary === 'string' && s.summary.trim()
    && typeof s.tool === 'string' && s.tool.startsWith('mcp__delma__')
    && s.input && typeof s.input === 'object'
  )
}

// Strip the <delma-suggest> block from any text chunk before it reaches
// the UI, so users never see the raw JSON in their chat.
function stripSuggestBlock(text) {
  return text.replace(/<delma-suggest>[\s\S]*?<\/delma-suggest>/gi, '').trimEnd()
}

export function getPendingSuggestion({ userId, id }) {
  return pendingSuggestions.get(`${userId}:${id}`) || null
}
export function deletePendingSuggestion({ userId, id }) {
  return pendingSuggestions.delete(`${userId}:${id}`)
}

// Map the public MCP tool name ("mcp__delma__delma_add_decision") to the
// tabKey + op name used by applyOpsToTab. Matches the wiring in server/mcp.js.
const TOOL_TO_OP = {
  'mcp__delma__delma_add_decision':            ['memory:decisions.md', 'add_decision'],
  'mcp__delma__delma_supersede_decision':      ['memory:decisions.md', 'supersede_decision'],
  'mcp__delma__delma_add_action':              ['memory:decisions.md', 'add_action'],
  'mcp__delma__delma_complete_action':         ['memory:decisions.md', 'complete_action'],
  'mcp__delma__delma_complete_action_by_text': ['memory:decisions.md', 'complete_action_by_text'],
  'mcp__delma__delma_set_environment_key':     ['memory:environment.md', 'set_environment_key'],
  'mcp__delma__delma_add_playbook_rule':       ['org:playbook.md', 'add_playbook_rule'],
  'mcp__delma__delma_add_person':              ['org:people.md', 'add_person'],
  'mcp__delma__delma_set_role':                ['org:people.md', 'set_role'],
  'mcp__delma__delma_set_manager':             ['org:people.md', 'set_manager'],
  'mcp__delma__delma_add_reporting_line':      ['org:people.md', 'add_reporting_line'],
  'mcp__delma__delma_remove_reporting_line':   ['org:people.md', 'remove_reporting_line'],
  'mcp__delma__delma_remove_person':           ['org:people.md', 'remove_person'],
  'mcp__delma__delma_arch_set_prose':          ['diagram:architecture', 'set_prose'],
  'mcp__delma__delma_arch_add_node':           ['diagram:architecture', 'add_node'],
  'mcp__delma__delma_arch_set_node_label':     ['diagram:architecture', 'set_node_label'],
  'mcp__delma__delma_arch_set_node_note':      ['diagram:architecture', 'set_node_note'],
  'mcp__delma__delma_arch_set_node_description': ['diagram:architecture', 'set_node_description'],
  'mcp__delma__delma_arch_set_node_kind':      ['diagram:architecture', 'set_node_kind'],
  'mcp__delma__delma_arch_move_node':          ['diagram:architecture', 'move_node_to_layer'],
  'mcp__delma__delma_arch_remove_node':        ['diagram:architecture', 'remove_node'],
  'mcp__delma__delma_arch_add_edge':           ['diagram:architecture', 'add_edge'],
  'mcp__delma__delma_arch_remove_edge':        ['diagram:architecture', 'remove_edge'],
  'mcp__delma__delma_arch_add_layer':          ['diagram:architecture', 'add_layer'],
  'mcp__delma__delma_arch_remove_layer':       ['diagram:architecture', 'remove_layer']
}

// Run a suggestion against Supabase. Takes the exact shape that was parked
// in pendingSuggestions plus caller identity. Returns the op's applied +
// errors result for the client to display.
export async function applySuggestion({ suggestion, userId, projectId, orgId }) {
  const mapped = TOOL_TO_OP[suggestion.tool]
  if (!mapped) throw new Error(`Unknown tool: ${suggestion.tool}`)
  const [tabKey, opName] = mapped
  const scope = parseTabKey(tabKey, { projectId, orgId, userId })
  return applyOpsToTab(sb, scope, [{ op: opName, args: suggestion.input || {} }])
}

// Per-message log line so the browser console (via /api/debug/logs) gets a
// turn-by-turn play-by-play: assistant text, tool_use, tool_result, final.
function logStreamMessage(msg) {
  const t = msg?.type
  if (t === 'assistant' && Array.isArray(msg?.message?.content)) {
    for (const c of msg.message.content) {
      if (c.type === 'text' && c.text) {
        console.log('[chat msg] assistant-text:', String(c.text).slice(0, 180))
      } else if (c.type === 'tool_use') {
        const inputStr = (() => { try { return JSON.stringify(c.input) } catch { return '(unserializable)' } })()
        console.log('[chat msg] tool_use:', c.name, inputStr.slice(0, 300))
        // Flag every filesystem-write attempt so we can audit weekly what
        // Claude is persisting outside MCP. If a pattern recurs, it's a
        // signal we need a new tab or MCP tool for that shape of data.
        const fsHit = detectScratchWrite(c.name, c.input)
        if (fsHit) console.log('[scratch-write]', c.name, '→', fsHit)
      }
    }
    return
  }
  if (t === 'user' && Array.isArray(msg?.message?.content)) {
    for (const c of msg.message.content) {
      if (c.type === 'tool_result') {
        const out = typeof c.content === 'string'
          ? c.content
          : (() => { try { return JSON.stringify(c.content) } catch { return '(unserializable)' } })()
        console.log('[chat msg] tool_result:', String(out).slice(0, 300))
      }
    }
    return
  }
  if (t === 'system' && msg?.subtype === 'init') {
    // Dump the tool catalog and MCP server status so we can see what the
    // agent actually has vs. what the prompt advertises.
    const mcpStatus = (msg.mcp_servers || []).map(s => `${s.name}=${s.status}`).join(', ')
    const delmaTools = (msg.tools || []).filter(t => t.startsWith('mcp__delma'))
    console.log('[chat msg] system init — mcp:', mcpStatus || '(none)', '| delma tools:', delmaTools.length, delmaTools.length ? `(${delmaTools.slice(0, 3).join(', ')}...)` : '')
    return
  }
  if (t === 'result' || t === 'system' || msg?.subtype === 'final') {
    console.log('[chat msg]', t || 'final', msg?.subtype || '')
    return
  }
}

// POST /api/chat/stream handler — wired up from server/index.js.
export async function handleChatStream(req, res) {
  // Authenticate before anything else. The chat can spawn the Agent SDK with
  // MCP write access to the workspace; a body-only userId/projectId would
  // let any caller act as anyone on any workspace.
  let authedUser
  try { authedUser = await requireUser(req) }
  catch (err) { return res.status(err.status || 401).json({ error: err.message }) }

  const { message, projectId } = req.body || {}
  if (!message || !projectId) {
    return res.status(400).json({ error: 'message and projectId required' })
  }
  if (message.length > MAX_MESSAGE_BYTES) {
    return res.status(413).json({ error: `Message too large (max ${MAX_MESSAGE_BYTES} chars).` })
  }
  if (!streamLimiter.allow(authedUser.id)) {
    return res.status(429).json({ error: 'Too many chat messages, slow down.' })
  }
  const userId = authedUser.id

  // Verify this user actually has access to this workspace before we spin up
  // the Agent SDK and hand it write tools.
  let projectOrgId = null
  try {
    const { data: ws } = await sb.from('projects').select('org_id').eq('id', projectId).single()
    if (!ws) return res.status(404).json({ error: 'workspace not found' })
    projectOrgId = ws.org_id
    try { await requireProjectMembership(sb, userId, projectId) }
    catch { await requireOrgMembership(sb, userId, ws.org_id) }
  } catch (err) { return res.status(err.status || 403).json({ error: err.message }) }

  // SFMC creds come from ~/.config/sfmc/.env (see server/lib/local-config.js).
  // Same on every turn, same across every project — credentials belong to
  // the user, not to a project. Passed through as env vars to the MCP
  // subprocess so sfmc-client tools have auth automatically.
  const sfmcAccounts = loadSfmcAccounts()

  // Resolve the user's active conversation FIRST so we can load its prior
  // turns into the system prompt. Persistence: the chat picks up where the
  // user left off, even after a reload or device switch.
  let conversationId
  try {
    conversationId = await getOrCreateConversation(projectId, userId)
  } catch (err) {
    return res.status(400).json({ error: err.message })
  }

  // Load prior turns for context. Trimmed to budget inside buildChatSystemPrompt.
  // Include tool_calls + tool rows so Claude sees evidence of its prior actions
  // (which tools it invoked, what came back) instead of just its own prose
  // summary — that was the self-doubt-and-re-verify failure mode.
  const { data: priorMessageRows } = await sb
    .from('messages')
    .select('role, content, tool_calls, tool_name, tool_call_id')
    .eq('conversation_id', conversationId)
    .order('id', { ascending: false })
    .limit(100)
  const priorMessages = (priorMessageRows || []).reverse()

  // Compose the per-turn system prompt: project state + org memory + SFMC
  // connection summary + prior conversation + behavior instructions.
  // Wrapped so a failure here returns 500 cleanly instead of taking the
  // Node process down — buildChatSystemPrompt runs before the SSE headers
  // are flushed, so a throw would bypass the main try/catch below.
  const { projectDir, sharedDir } = ensureScratchDirs(projectId, projectOrgId)

  let systemPrompt
  try {
    systemPrompt = await buildChatSystemPrompt({
      projectId, orgId: projectOrgId, sfmcAccounts, priorMessages, projectDir, sharedDir
    })
  } catch (err) {
    console.error('[chat] buildChatSystemPrompt failed:', err)
    return res.status(500).json({ error: 'prompt build failed', detail: err.message })
  }

  const systemPromptChars = Array.isArray(systemPrompt)
    ? systemPrompt.reduce((n, s) => n + (s?.length || 0), 0)
    : systemPrompt.length
  console.log('[chat] turn start',
    'user:', userId.slice(0, 8),
    'project:', projectId.slice(0, 8),
    'org:', projectOrgId?.slice(0, 8),
    'sfmc:', Object.keys(sfmcAccounts || {}).join(',') || 'none',
    'priorTurns:', priorMessages.length,
    'systemPromptChars:', systemPromptChars,
    'cached:', Array.isArray(systemPrompt) ? 'yes' : 'no',
    'messageChars:', message.length
  )

  // Persist the user message before the turn starts.
  await saveMessage(conversationId, { role: 'user', content: message })

  res.setHeader('Content-Type', 'text/event-stream')
  res.setHeader('Cache-Control', 'no-cache, no-transform')
  res.setHeader('Connection', 'keep-alive')
  res.flushHeaders?.()

  // Tell the client which conversation this stream belongs to (for
  // replay/history after refresh).
  sseEvent(res, 'meta', { conversationId })

  // Abort plumbing: client closes the SSE (user hits Stop, refreshes, or
  // navigates away) → req emits 'close' → we abort the Agent SDK, which
  // SIGTERMs its claude subprocess and any in-flight Bash/MCP calls.
  // Without this, the subprocess keeps running past the client disconnect
  // and burns tokens on work nobody's watching.
  const abortController = new AbortController()
  let clientClosed = false
  req.on('close', () => {
    if (res.writableEnded) return
    clientClosed = true
    abortController.abort()
  })

  try {
    const result = query({
      prompt: message,
      options: {
        model: DEFAULT_MODEL,
        cwd: projectDir,
        ...(sharedDir ? { additionalDirectories: [sharedDir] } : {}),
        systemPrompt,
        env: {
          ...process.env,
          ...sfmcEnvVars(sfmcAccounts),
          DELMA_SHARED_DIR: sharedDir || '',
          DELMA_PROJECT_DIR: projectDir
        },
        mcpServers: delmaMcpConfig({ userId, projectId, sfmcAccounts }),
        abortController,
        // Surface the Agent SDK's subprocess stderr (includes MCP write/read
        // traces that'd otherwise be invisible) through our logs so the debug
        // stream can relay them to the browser.
        stderr: (data) => {
          const text = String(data || '').trimEnd()
          if (text) console.log('[agent-sdk]', text)
        },
        allowedTools: [
          'Bash', 'Read', 'Write', 'Edit', 'Glob', 'Grep', 'WebFetch'
        ],
        // Delma mutations are NOT invoked by the agent. The system prompt
        // tells Claude to emit a <delma-suggest>[...]</delma-suggest> block
        // at the end of its response; we parse that block after the turn
        // and surface each entry as a "should we update X with Y?" button
        // in the UI. Any rogue mcp__delma__* call is denied.
        canUseTool: async (toolName) => {
          if (toolName.startsWith('mcp__delma__')) {
            return { behavior: 'deny', message: 'Never call Delma tools directly. Emit a <delma-suggest> block at the end of your response instead.' }
          }
          return { behavior: 'allow' }
        }
      }
    })

    // Accumulate all assistant text from this turn so we can scan it for
    // the <delma-suggest> block after the SDK finishes streaming.
    let fullAssistantText = ''
    for await (const msg of result) {
      // Strip the <delma-suggest> block from assistant text chunks BEFORE
      // forwarding so the user never sees the raw JSON in the chat.
      if (msg?.type === 'assistant' && Array.isArray(msg.message?.content)) {
        for (const c of msg.message.content) {
          if (c.type === 'text' && typeof c.text === 'string') {
            fullAssistantText += c.text
            c.text = stripSuggestBlock(c.text)
          }
        }
      }
      sseEvent(res, 'message', msg)
      try { logStreamMessage(msg) } catch { /* best-effort tracing */ }
      try { await saveMessage(conversationId, msg) }
      catch (err) { console.warn('[chat] save message failed (non-fatal):', err.message) }
    }
    // Parse + emit suggestions the frontend can render as buttons.
    const suggestions = parseSuggestions(fullAssistantText)
    const rawBlock = (fullAssistantText.match(/<delma-suggest>[\s\S]*?<\/delma-suggest>/i) || [null])[0]
    if (rawBlock) console.log('[chat] <delma-suggest> block detected, parsed', suggestions.length, 'valid suggestion(s)')
    else console.log('[chat] no <delma-suggest> block emitted by agent this turn')
    if (suggestions.length) {
      const stamped = suggestions.map(s => ({
        id: `sug_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`,
        ...s
      }))
      for (const s of stamped) {
        pendingSuggestions.set(`${userId}:${s.id}`, s)
      }
      sseEvent(res, 'suggestions', { items: stamped })
      console.log('[chat] emitted', stamped.length, 'suggestion(s) for user', userId.slice(0, 8))
    }
    sseEvent(res, 'done', {})
    console.log('[chat] turn done user:', userId.slice(0, 8), 'project:', projectId.slice(0, 8))
  } catch (err) {
    if (clientClosed || err.name === 'AbortError' || abortController.signal.aborted) {
      console.log('[chat] turn aborted by client')
    } else {
      console.error('[chat] stream error:', err)
      sseEvent(res, 'error', { message: err.message })
    }
  } finally {
    res.end()
  }
}
