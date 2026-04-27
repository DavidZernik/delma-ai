// Local-mode chat stream. Reads the project's CLAUDE.md, injects it as
// system prompt, calls Claude via the Agent SDK, streams text + tool
// activity back over SSE, parses <delma-suggest> blocks after the turn,
// and surfaces each entry as a Yes/No card the user can apply.
//
// No Supabase. No auth (server is bound to localhost). Conversations
// persist as a plain JSON file at <project>/.delma/chat-history.json —
// the user can .gitignore it if they prefer sessions private.

import { query } from '@anthropic-ai/claude-agent-sdk'
import { readFileSync, existsSync } from 'node:fs'
import { resolve as resolvePath, join, basename } from 'node:path'
import { loadDelmaConfig, loadSfmcAccounts, CONFIG_PATHS, atomicWrite, safeResolveProjectPath } from '../lib/local-config.js'
import { readOrSeedClaudeMd } from '../lib/claude-md.js'
import { applySuggestionToClaudeMd } from '../lib/apply-to-claude-md.js'
import { SYSTEM_PROMPT_DYNAMIC_BOUNDARY } from '@anthropic-ai/claude-agent-sdk'

function sseEvent(res, event, data) {
  res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`)
}

// Delma's MCP tools split into two groups. Delma-doc mutations write to
// CLAUDE.md and ALWAYS go through the suggestion/approval flow — we deny
// them in canUseTool so the agent is forced to propose via <delma-suggest>.
// SFMC operations (mcp__delma__delma_sfmc_*) talk to Marketing Cloud
// directly; their effects live in SFMC, not in our markdown docs, so they
// run freely. Bash/Read/Edit and the rest are not delma tools at all.
function isDelmaDocMutation(toolName) {
  if (!toolName.startsWith('mcp__delma__')) return false
  // Read-only delma tools (state inspection, compose, listing) — allow.
  if (/^mcp__delma__(get_|list_|compose_)/.test(toolName)) return false
  // SFMC ops — allow (reads inspect the tenant; writes live in SFMC).
  if (toolName.startsWith('mcp__delma__delma_sfmc_')) return false
  // Everything else under mcp__delma__delma_* is a workspace-doc mutation.
  return true
}

// Build the system prompt for a local project. The CLAUDE.md content IS
// the project context — we drop the whole file in verbatim, then append
// Delma's saving-instructions block (the <delma-suggest> protocol).
function buildLocalSystemPrompt({ projectDir, claudeMdRaw }) {
  const lines = []
  lines.push(`# Delma — In-app assistant for ${basename(projectDir)}`)
  lines.push(``)
  lines.push(`You are the in-app collaborator for this project. The project's full state lives in \`${projectDir}/CLAUDE.md\` — the file content is below. Trust it as the source of truth. When the user asks about the project, answer from this context. When the user shares durable info, propose an update to the file via the <delma-suggest> block described below.`)
  lines.push(``)
  lines.push(`## Project's CLAUDE.md (current state)`)
  lines.push('```markdown')
  lines.push(claudeMdRaw)
  lines.push('```')
  lines.push(``)
  lines.push(SYSTEM_PROMPT_DYNAMIC_BOUNDARY)
  lines.push(``)
  lines.push(`## How saving works`)
  lines.push(`Do NOT call any \`mcp__delma__*\` tools directly. At the END of your response — and only if the exchange contains durable info worth saving — append EXACTLY this block:`)
  lines.push(``)
  lines.push(`<delma-suggest>`)
  lines.push(`[`)
  lines.push(`  {"tab": "Project Details", "summary": "human description", "tool": "mcp__delma__delma_add_decision", "input": { "text": "..." }}`)
  lines.push(`]`)
  lines.push(`</delma-suggest>`)
  lines.push(``)
  lines.push(`**"tab" must be one of:** \`Project Details\`, \`General Patterns and Docs\`, \`People\`.`)
  lines.push(``)
  lines.push(`**Routing:**`)
  lines.push(`- Goals, definitions, open questions → tab: \`Project Details\`, tool: \`mcp__delma__delma_add_decision\` (locked-in facts) or \`mcp__delma__delma_add_action\` (open items).`)
  lines.push(`- Folder/DE/customer-key/URL specifics → tab: \`Project Details\`, tool: \`mcp__delma__delma_set_environment_key\` with \`{"key": "...", "value": "..."}\`.`)
  lines.push(`- Operational rules / unwritten norms → tab: \`General Patterns and Docs\`, tool: \`mcp__delma__delma_add_playbook_rule\`.`)
  lines.push(`- Stakeholders, roles, reporting lines → tab: \`People\`, tool: \`mcp__delma__delma_add_person\` / \`delma_add_reporting_line\`.`)
  lines.push(``)
  lines.push(`**If nothing is worth saving, OMIT the block entirely.** No empty arrays, no placeholders. Most messages won't have a block.`)
  lines.push(``)
  lines.push(`**Open questions you surface in prose should ALSO have matching action suggestions** — don't just list unanswered questions and move on.`)
  lines.push(``)
  lines.push(`Respond concisely. The user is marketing-ops focused, not a software engineer.`)
  return lines.join('\n')
}

function parseSuggestions(text) {
  if (!text) return []
  const m = text.match(/<delma-suggest>([\s\S]*?)<\/delma-suggest>/i)
  if (!m) return []
  const body = m[1].trim().replace(/^```(?:json)?/i, '').replace(/```$/, '').trim()
  let parsed
  try { parsed = JSON.parse(body) } catch { return [] }
  if (!Array.isArray(parsed)) return []
  const ALLOWED = new Set(['Project Details', 'General Patterns and Docs', 'People'])
  return parsed.filter(s =>
    s && typeof s === 'object'
    && ALLOWED.has(s.tab)
    && typeof s.summary === 'string' && s.summary.trim()
    && typeof s.tool === 'string' && s.tool.startsWith('mcp__delma__')
    && s.input && typeof s.input === 'object'
  )
}

function stripSuggestBlock(text) {
  return text.replace(/<delma-suggest>[\s\S]*?<\/delma-suggest>/gi, '').trimEnd()
}

// Conversation persistence. <project>/.delma/chat-history.json holds the
// most recent N user+assistant turns. Keeps the assistant in context
// across sessions without a database.
function historyPath(projectDir) {
  return join(projectDir, '.delma', 'chat-history.json')
}
export function readHistory(projectDir) {
  const p = historyPath(projectDir)
  if (!existsSync(p)) return []
  try { return JSON.parse(readFileSync(p, 'utf8')) }
  catch { return [] }
}
function appendHistory(projectDir, turn) {
  const p = historyPath(projectDir)
  const existing = readHistory(projectDir)
  existing.push(turn)
  // Cap at 100 turns to keep file small.
  const trimmed = existing.slice(-100)
  atomicWrite(p, JSON.stringify(trimmed, null, 2))
}
export function clearHistory(projectDir) {
  const p = historyPath(projectDir)
  if (existsSync(p)) atomicWrite(p, '[]')
}

// MCP subprocess config — same Delma MCP server, started fresh per turn.
// SFMC env vars come from local ~/.config/sfmc/.env (not Supabase).
function delmaMcpConfig(projectDir) {
  const sfmc = loadSfmcAccounts()
  const env = { ...process.env, DELMA_PROJECT_DIR: projectDir }
  const c = sfmc.child, p = sfmc.parent
  if (c) Object.assign(env, {
    CLIENT_ID: c.client_id, CLIENT_SECRET: c.client_secret,
    SFMC_MID: c.account_id || '',
    SFMC_AUTH_BASE_URL: c.auth_base_url, SFMC_REST_BASE_URL: c.rest_base_url, SFMC_SOAP_BASE_URL: c.soap_base_url
  })
  if (p) Object.assign(env, {
    PARENT_BU_CLIENT_ID: p.client_id, PARENT_BU_CLIENT_SECRET: p.client_secret,
    PARENT_BU_MID: p.account_id || '',
    PARENT_BU_AUTH_BASE_URL: p.auth_base_url, PARENT_BU_REST_BASE_URL: p.rest_base_url, PARENT_BU_SOAP_BASE_URL: p.soap_base_url
  })
  return {
    delma: {
      type: 'stdio',
      command: 'node',
      args: [join(process.cwd(), 'server', 'mcp.js')],
      env
    }
  }
}

// ── Pending suggestions ──────────────────────────────────────────────────
const pendingSuggestions = new Map() // key: `${projectDir}:${id}`

export function getPendingLocal(projectDir, id) {
  return pendingSuggestions.get(`${projectDir}:${id}`) || null
}
export function deletePendingLocal(projectDir, id) {
  return pendingSuggestions.delete(`${projectDir}:${id}`)
}

// ── HTTP handlers ────────────────────────────────────────────────────────

export async function handleLocalChatStream(req, res) {
  const { path, message } = req.body || {}
  if (!message) return res.status(400).json({ error: 'message required' })
  let projectDir
  try { projectDir = safeResolveProjectPath(path) }
  catch (err) { return res.status(400).json({ error: err.message }) }
  if (!existsSync(projectDir)) return res.status(404).json({ error: `folder not found: ${projectDir}` })

  const cfg = loadDelmaConfig()
  if (!cfg.anthropic_api_key) {
    return res.status(400).json({ error: `No Anthropic API key configured. Save one to ${CONFIG_PATHS.delmaConfig}.` })
  }

  // Load project state + history.
  const doc = readOrSeedClaudeMd(projectDir, { projectName: basename(projectDir) })
  const history = readHistory(projectDir)

  const systemPrompt = buildLocalSystemPrompt({ projectDir, claudeMdRaw: doc.raw })

  // SSE headers.
  res.setHeader('Content-Type', 'text/event-stream')
  res.setHeader('Cache-Control', 'no-cache, no-transform')
  res.setHeader('Connection', 'keep-alive')
  res.flushHeaders?.()

  // Save user turn to history up front so reloads see it.
  appendHistory(projectDir, { role: 'user', content: message, ts: Date.now() })

  console.log('[local-chat] turn start — project:', basename(projectDir), 'msg chars:', message.length, 'history turns:', history.length)

  const abortController = new AbortController()
  req.on('close', () => abortController.abort())

  let fullAssistantText = ''
  let messageCount = 0
  try {
    console.log('[local-chat] building query — model:', cfg.model || 'claude-sonnet-4-5', 'cwd:', projectDir)
    const result = query({
      prompt: message,
      options: {
        model: cfg.model || 'claude-sonnet-4-5',
        cwd: projectDir,
        systemPrompt,
        env: {
          ...process.env,
          ANTHROPIC_API_KEY: cfg.anthropic_api_key,
          DELMA_PROJECT_DIR: projectDir
        },
        mcpServers: delmaMcpConfig(projectDir),
        abortController,
        stderr: (data) => {
          const text = String(data || '').trim()
          if (text) console.log('[agent-sdk-stderr]', text.slice(0, 300))
        },
        // Gate the agent's tool access. Delma-doc mutations (decisions,
        // people, playbook, architecture) go through <delma-suggest> so
        // the user approves each write. SFMC operations — reads AND
        // writes — run directly: reads are how the agent inspects the
        // tenant, and SFMC mutations live in SFMC itself, not in our
        // markdown docs. Non-delma tools (Bash, Read, Edit, etc.) run
        // freely.
        canUseTool: async (toolName) => {
          if (isDelmaDocMutation(toolName)) {
            return {
              behavior: 'deny',
              message: 'Never call this tool directly. Propose the change via <delma-suggest> at the end of your response so the user can approve it.'
            }
          }
          return { behavior: 'allow' }
        },
        allowedTools: ['Bash', 'Read', 'Write', 'Edit', 'Glob', 'Grep', 'WebFetch']
      }
    })

    for await (const msg of result) {
      messageCount++
      if (messageCount <= 3) console.log('[local-chat] msg', messageCount, 'type:', msg?.type, 'subtype:', msg?.subtype)
      // Strip the <delma-suggest> block from visible text chunks.
      if (msg?.type === 'assistant' && Array.isArray(msg.message?.content)) {
        for (const c of msg.message.content) {
          if (c.type === 'text' && typeof c.text === 'string') {
            fullAssistantText += c.text
            c.text = stripSuggestBlock(c.text)
          }
        }
      }
      sseEvent(res, 'message', msg)
    }
    console.log('[local-chat] SDK loop done, total messages:', messageCount)

    // Persist assistant text (stripped) + parse/emit suggestions.
    const visible = stripSuggestBlock(fullAssistantText)
    if (visible.trim()) appendHistory(projectDir, { role: 'assistant', content: visible, ts: Date.now() })
    const suggestions = parseSuggestions(fullAssistantText)
    if (suggestions.length) {
      const stamped = suggestions.map(s => ({
        id: `sug_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`,
        ...s
      }))
      for (const s of stamped) pendingSuggestions.set(`${projectDir}:${s.id}`, s)
      sseEvent(res, 'suggestions', { items: stamped })
    }
    sseEvent(res, 'done', {})
  } catch (err) {
    if (!abortController.signal.aborted) {
      console.error('[local-chat] stream error:', err)
      sseEvent(res, 'error', { message: err.message })
    }
  } finally {
    res.end()
  }
}

export async function handleLocalApplySuggestion(req, res) {
  const { path, id } = req.body || {}
  if (!id) return res.status(400).json({ error: 'id required' })
  let projectDir
  try { projectDir = safeResolveProjectPath(path) }
  catch (err) { return res.status(400).json({ error: err.message }) }
  const suggestion = getPendingLocal(projectDir, id)
  if (!suggestion) return res.status(404).json({ error: 'suggestion not found' })
  try {
    const result = applySuggestionToClaudeMd(projectDir, suggestion)
    deletePendingLocal(projectDir, id)
    res.json({ ok: true, ...result })
  } catch (err) {
    console.error('[local-chat] apply failed:', err.message)
    res.status(500).json({ error: err.message })
  }
}

export function handleLocalDismissSuggestion(req, res) {
  const { path, id } = req.body || {}
  if (!id) return res.status(400).json({ error: 'id required' })
  let projectDir
  try { projectDir = safeResolveProjectPath(path) }
  catch (err) { return res.status(400).json({ error: err.message }) }
  deletePendingLocal(projectDir, id)
  res.json({ ok: true })
}

export function handleLocalHistory(req, res) {
  let projectDir
  try { projectDir = safeResolveProjectPath(req.query.path) }
  catch (err) { return res.status(400).json({ error: err.message }) }
  res.json({ messages: readHistory(projectDir) })
}

export function handleLocalClear(req, res) {
  const { path } = req.body || {}
  let projectDir
  try { projectDir = safeResolveProjectPath(path) }
  catch (err) { return res.status(400).json({ error: err.message }) }
  clearHistory(projectDir)
  res.json({ ok: true })
}
