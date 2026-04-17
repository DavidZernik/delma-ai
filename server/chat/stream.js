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

const SCRATCH_ROOT = process.env.DELMA_SCRATCH_ROOT || '/tmp/delma-workspaces'
const DEFAULT_MODEL = process.env.DELMA_CHAT_MODEL || 'claude-sonnet-4-5'

// Per-workspace scratch directory. Agent SDK runs with cwd set here, so
// anything Claude writes lands in a workspace-scoped space. Survives
// across chat turns; cleaned manually (later: quotas + auto-cleanup).
function ensureScratchDir(workspaceId) {
  const dir = join(SCRATCH_ROOT, workspaceId)
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true })
  return dir
}

// The Delma MCP server is started as a subprocess by Agent SDK. It exposes
// all of Delma's typed ops (add_person, add_decision, add_node, ...) as
// MCP tools, scoped to this user+workspace via env vars.
function delmaMcpConfig({ userId, workspaceId }) {
  return {
    delma: {
      type: 'stdio',
      command: 'node',
      args: [join(process.cwd(), 'server', 'mcp.js')],
      env: {
        ...process.env,
        DELMA_USER_ID: userId,
        DELMA_WORKSPACE_ID: workspaceId
      }
    }
  }
}

// Or-create the single long-running conversation for this workspace.
async function getOrCreateConversation(workspaceId, userId) {
  const { data: existing } = await sb
    .from('conversations')
    .select('id')
    .eq('workspace_id', workspaceId)
    .eq('archived', false)
    .order('updated_at', { ascending: false })
    .limit(1)
    .maybeSingle()
  if (existing) return existing.id

  const { data: created, error } = await sb
    .from('conversations')
    .insert({ workspace_id: workspaceId, user_id: userId, title: null })
    .select('id')
    .single()
  if (error) throw new Error(`conversation create failed: ${error.message}`)
  return created.id
}

// Persist a single message to Supabase. Called from the streaming loop as
// each Agent SDK message lands.
async function saveMessage(conversationId, message) {
  const { role, content, tool_calls, tool_call_id, tool_name, model, usage } = message
  await sb.from('messages').insert({
    conversation_id: conversationId,
    role,
    content: typeof content === 'string' ? content : JSON.stringify(content),
    tool_calls: tool_calls || null,
    tool_call_id: tool_call_id || null,
    tool_name: tool_name || null,
    tokens_in: usage?.input_tokens || null,
    tokens_out: usage?.output_tokens || null,
    model: model || null
  })
}

// Rough translator from Agent SDK messages to what assistant-ui expects.
// Agent SDK streams typed messages (user, assistant, tool_use, tool_result,
// etc.); we forward them as SSE events the client can render directly.
function sseEvent(res, event, data) {
  res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`)
}

// POST /api/chat/stream handler — wired up from server/index.js.
export async function handleChatStream(req, res) {
  const { message, workspaceId, userId } = req.body || {}
  if (!message || !workspaceId || !userId) {
    return res.status(400).json({ error: 'message, workspaceId, userId required' })
  }

  let conversationId
  try {
    const scratchDir = ensureScratchDir(workspaceId)
    conversationId = await getOrCreateConversation(workspaceId, userId)
  } catch (err) {
    return res.status(400).json({ error: err.message })
  }
  const scratchDir = ensureScratchDir(workspaceId)

  // Persist the user message before the turn starts.
  await saveMessage(conversationId, { role: 'user', content: message })

  res.setHeader('Content-Type', 'text/event-stream')
  res.setHeader('Cache-Control', 'no-cache, no-transform')
  res.setHeader('Connection', 'keep-alive')
  res.flushHeaders?.()

  // Tell the client which conversation this stream belongs to (for
  // replay/history after refresh).
  sseEvent(res, 'meta', { conversationId })

  try {
    // Run the Agent SDK query. This is Claude Code's actual loop: it can
    // use Bash, read/write files in scratchDir, call Delma MCP tools, and
    // iterate across multiple tool calls within a single user turn.
    const result = query({
      prompt: message,
      options: {
        model: DEFAULT_MODEL,
        cwd: scratchDir,
        mcpServers: delmaMcpConfig({ userId, workspaceId }),
        // Default to Claude Code's full toolset. Later we can scope per-tier.
        allowedTools: [
          'Bash', 'Read', 'Write', 'Edit', 'Glob', 'Grep', 'WebFetch',
          // MCP tools from the delma server are auto-allowed when prefixed
          // 'mcp__delma__*' — Agent SDK matches these via the pattern.
          'mcp__delma'
        ]
      }
    })

    // Stream each SDK message out as SSE + persist to DB.
    for await (const msg of result) {
      sseEvent(res, 'message', msg)
      try { await saveMessage(conversationId, msg) }
      catch (err) { console.warn('[chat] save message failed (non-fatal):', err.message) }
    }
    sseEvent(res, 'done', {})
  } catch (err) {
    console.error('[chat] stream error:', err)
    sseEvent(res, 'error', { message: err.message })
  } finally {
    res.end()
  }
}
