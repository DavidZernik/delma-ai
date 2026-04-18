// Custom hook: SSE consumer for /api/chat/stream. Parses the event stream
// Agent SDK emits and surfaces a tidy { messages, send, status } interface
// the React component renders against.
//
// Keeping this thin so we can swap @assistant-ui for a different chat UI
// library later without touching the streaming logic. The adapter layer
// is exactly this file.

import { useCallback, useEffect, useRef, useState } from 'react'
import { supabase } from '../lib/supabase.js'

async function authHeader() {
  const { data: { session } } = await supabase.auth.getSession()
  const token = session?.access_token
  return token ? { Authorization: `Bearer ${token}` } : {}
}

export function useChatStream({ projectId, userId }) {
  const [messages, setMessages] = useState([])   // normalized for UI
  const [status, setStatus] = useState('idle')   // 'idle' | 'streaming' | 'error' | 'loading'
  const [conversationId, setConversationId] = useState(null)
  const abortRef = useRef(null)

  // Load prior conversation on mount / project switch. Server returns the
  // user's active (non-archived) conversation for this project — empty array
  // if none yet. Reload-safe: messages survive page refresh.
  useEffect(() => {
    if (!projectId) return
    let cancelled = false
    setStatus('loading')
    setMessages([])
    setConversationId(null)
    ;(async () => {
      try {
        const res = await fetch(`/api/chat/history?projectId=${encodeURIComponent(projectId)}`, {
          headers: { ...(await authHeader()) }
        })
        if (!res.ok) throw new Error(`history ${res.status}`)
        const data = await res.json()
        if (cancelled) return
        // Server returns DB-shape rows: { id, role, content, tool_calls, tool_name, created_at }.
        // Map to UI shape. Tool messages come back as role='tool' with content
        // (we serialized to text on save), so render them as a small bubble.
        const ui = (data.messages || []).map(m => ({
          id: 'h' + m.id,
          role: m.role,
          content: m.content || '',
          tools: Array.isArray(m.tool_calls) ? m.tool_calls : []
        }))
        setMessages(ui)
        setConversationId(data.conversationId)
        setStatus('idle')
      } catch (err) {
        if (cancelled) return
        console.warn('[chat] history load failed:', err.message)
        setStatus('idle') // still usable; just starts blank
      }
    })()
    return () => { cancelled = true }
  }, [projectId])

  const send = useCallback(async (userText) => {
    if (status === 'streaming' || status === 'loading') return
    setStatus('streaming')

    // Optimistic user message.
    setMessages(prev => [...prev, { id: crypto.randomUUID(), role: 'user', content: userText }])

    const ctrl = new AbortController()
    abortRef.current = ctrl

    try {
      const res = await fetch('/api/chat/stream', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...(await authHeader()) },
        // userId is taken from the verified JWT server-side; we still send
        // projectId so the server knows which project to scope to.
        body: JSON.stringify({ message: userText, projectId }),
        signal: ctrl.signal
      })
      if (!res.ok || !res.body) {
        throw new Error(`stream failed: ${res.status}`)
      }

      // Manual SSE parser — the Fetch response body is a ReadableStream of
      // text. SSE frames are separated by blank lines; each line starts
      // with a key (`event:` or `data:`).
      const reader = res.body.getReader()
      const decoder = new TextDecoder()
      let buffer = ''
      let currentAssistant = null

      while (true) {
        const { value, done } = await reader.read()
        if (done) break
        buffer += decoder.decode(value, { stream: true })
        let idx
        while ((idx = buffer.indexOf('\n\n')) !== -1) {
          const frame = buffer.slice(0, idx)
          buffer = buffer.slice(idx + 2)
          const parsed = parseFrame(frame)
          if (!parsed) continue

          if (parsed.event === 'meta') {
            setConversationId(parsed.data.conversationId)
            continue
          }
          if (parsed.event === 'error') {
            setStatus('error')
            setMessages(prev => [...prev, { id: crypto.randomUUID(), role: 'system', content: `Error: ${parsed.data.message}` }])
            continue
          }
          if (parsed.event === 'done') {
            currentAssistant = null
            continue
          }
          if (parsed.event === 'message') {
            const m = parsed.data
            // Agent SDK emits various message shapes: assistant-text, tool_use,
            // tool_result, system. Surface what's meaningful to the UI and
            // group sequential assistant chunks into a single bubble.
            if (m.type === 'assistant' || m.role === 'assistant') {
              const text = extractText(m)
              const toolUse = extractToolUses(m)
              if (currentAssistant) {
                setMessages(prev => prev.map(x =>
                  x.id === currentAssistant ? { ...x, content: (x.content || '') + text, tools: [...(x.tools || []), ...toolUse] } : x
                ))
              } else {
                const id = crypto.randomUUID()
                currentAssistant = id
                setMessages(prev => [...prev, { id, role: 'assistant', content: text, tools: toolUse }])
              }
            } else if (m.type === 'user' && m.message?.content) {
              // Tool results come through as user-role messages from Agent SDK.
              const toolResults = extractToolResults(m)
              if (toolResults.length) {
                setMessages(prev => [...prev, { id: crypto.randomUUID(), role: 'tool', results: toolResults }])
              }
            } else if (m.type === 'result' || m.subtype === 'final') {
              // Final wrap message — end of turn.
              currentAssistant = null
            }
          }
        }
      }
      setStatus('idle')
    } catch (err) {
      if (err.name === 'AbortError') { setStatus('idle'); return }
      console.error('[chat] stream error:', err)
      setStatus('error')
      setMessages(prev => [...prev, { id: crypto.randomUUID(), role: 'system', content: `Error: ${err.message}` }])
    } finally {
      abortRef.current = null
    }
  }, [projectId, userId, status])

  const abort = useCallback(() => {
    abortRef.current?.abort()
  }, [])

  return { messages, status, conversationId, send, abort }
}

function parseFrame(frame) {
  const lines = frame.split('\n')
  let event = 'message'
  const dataLines = []
  for (const line of lines) {
    if (line.startsWith('event:')) event = line.slice(6).trim()
    else if (line.startsWith('data:')) dataLines.push(line.slice(5).trim())
  }
  if (!dataLines.length) return null
  try { return { event, data: JSON.parse(dataLines.join('\n')) } }
  catch { return null }
}

function extractText(msg) {
  const content = msg.message?.content || msg.content
  if (!content) return ''
  if (typeof content === 'string') return content
  if (Array.isArray(content)) {
    return content.filter(c => c.type === 'text').map(c => c.text).join('')
  }
  return ''
}

function extractToolUses(msg) {
  const content = msg.message?.content || msg.content
  if (!Array.isArray(content)) return []
  return content.filter(c => c.type === 'tool_use').map(c => ({
    id: c.id, name: c.name, input: c.input
  }))
}

function extractToolResults(msg) {
  const content = msg.message?.content
  if (!Array.isArray(content)) return []
  return content.filter(c => c.type === 'tool_result').map(c => ({
    tool_use_id: c.tool_use_id,
    output: typeof c.content === 'string' ? c.content : JSON.stringify(c.content)
  }))
}
