// Minimal chat sidebar for Delma. Subscribes to /api/chat/stream via the
// custom useChatStream hook, renders messages + tool calls + input.
//
// Deliberately lightweight: no @assistant-ui yet. Once the end-to-end flow
// is proven, swap this rendering layer for assistant-ui to get markdown,
// code blocks, tool-call collapsing, etc. The hook interface is stable.

import React, { useEffect, useRef, useState } from 'react'
import { marked } from 'marked'
import { useChatStream } from './useChatStream.js'

// Streaming text comes in partial — if we render each chunk the moment it
// arrives, marked can mis-parse mid-token markdown. Small helper: render
// what we have, let browser handle invalid HTML gracefully.
marked.setOptions({ breaks: true, gfm: true })
function renderChatMarkdown(text) {
  try { return marked.parse(text || '') }
  catch { return (text || '').replace(/[<>&]/g, c => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;' }[c])) }
}

export function ChatSidebar({ projectId, userId }) {
  const { messages, status, send, abort, clear, currentTool, suggestions, applySuggestion, dismissSuggestion } = useChatStream({ projectId, userId })
  const [input, setInput] = useState('')
  const [composerHeight, setComposerHeight] = useState(120)
  const thinkingLabel = useThinkingLabel()
  const scrollRef = useRef(null)

  useEffect(() => {
    scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight, behavior: 'smooth' })
  }, [messages])

  const onResizeStart = (e) => {
    e.preventDefault()
    const startY = e.clientY
    const startH = composerHeight
    const onMove = (ev) => {
      const next = Math.max(60, Math.min(window.innerHeight - 160, startH + (startY - ev.clientY)))
      setComposerHeight(next)
    }
    const onUp = () => {
      window.removeEventListener('mousemove', onMove)
      window.removeEventListener('mouseup', onUp)
    }
    window.addEventListener('mousemove', onMove)
    window.addEventListener('mouseup', onUp)
  }

  const onSubmit = (e) => {
    e.preventDefault()
    const trimmed = input.trim()
    if (!trimmed || status === 'streaming') return
    setInput('')
    send(trimmed)
  }

  return (
    <div dir="ltr" lang="en" style={styles.container}>
      <div style={styles.header}>
        <strong>Delma Chat</strong>
        <div style={{ display: 'flex', gap: 6 }}>
          {status === 'streaming' && (
            <button onClick={abort} style={styles.stopBtn}>Stop</button>
          )}
          <button
            onClick={clear}
            disabled={status === 'clearing'}
            style={{
              ...styles.clearBtn,
              opacity: status === 'clearing' ? 0.6 : 1,
              cursor: status === 'clearing' ? 'wait' : 'pointer',
              display: 'inline-flex', alignItems: 'center', gap: 6
            }}
          >
            {status === 'clearing' && <span className="delma-spinner" />}
            {status === 'clearing' ? 'Clearing…' : 'Clear'}
          </button>
        </div>
      </div>

      <div ref={scrollRef} style={styles.messages}>
        {messages.length === 0 && (
          <div style={styles.empty}>
            Talk about your SFMC work. Claude has access to your Delma workspace + bash + file tools.
          </div>
        )}
        {messages.map((m, i) => {
          const isLatestAssistant = m.role === 'assistant'
            && status !== 'streaming'
            && i === messages.length - 1
          return (
            <MessageBubble
              key={m.id}
              msg={m}
              isLatestAssistant={isLatestAssistant}
              onAnswer={(ans) => send(ans === 'yes' ? 'Yes, go ahead.' : 'No, don\'t change anything.')}
            />
          )
        })}
        {status === 'streaming' && (
          <div style={styles.thinking}>⟳ {currentTool ? formatToolStatus(currentTool) : thinkingLabel}</div>
        )}
        {suggestions.map(s => (
          <SuggestionCard
            key={s.id}
            suggestion={s}
            onApply={() => applySuggestion(s.id)}
            onDismiss={() => dismissSuggestion(s.id)}
          />
        ))}
      </div>

      <div style={styles.toolbar}>
        <button
          type="button"
          style={styles.newEmailBtn}
          onClick={() => window.delmaOpenEmailModal?.()}
          title="Create a new email from your block library"
        >
          <span aria-hidden="true" style={{ marginRight: 6 }}>✉</span>
          New Email
        </button>
      </div>

      <div style={styles.resizeHandle} onMouseDown={onResizeStart} title="Drag to resize" />
      <form onSubmit={onSubmit} style={{ ...styles.inputRow, height: composerHeight }}>
        <textarea
          value={input}
          onChange={e => setInput(e.target.value)}
          onKeyDown={e => {
            if (e.key === 'Enter' && !e.shiftKey) { onSubmit(e) }
          }}
          placeholder="Ask about your project, make changes, iterate…"
          disabled={status === 'streaming'}
          style={styles.input}
        />
        <button type="submit" disabled={status === 'streaming' || !input.trim()} style={styles.sendBtn}>
          Send
        </button>
      </form>
    </div>
  )
}

function ToolChip({ tool }) {
  const [open, setOpen] = useState(false)
  const summary = summarizeTool(tool)
  return (
    <div style={styles.toolCall}>
      <button onClick={() => setOpen(o => !o)} style={styles.toolChip} type="button">
        <span style={styles.toolChipIcon}>{open ? '▾' : '▸'}</span>
        <code style={styles.toolName}>{tool.name}</code>
        <span style={styles.toolChipSummary}>{summary}</span>
      </button>
      {open && tool.name === 'Bash' && tool.input?.command && (
        <pre style={styles.toolInput}>{tool.input.command}</pre>
      )}
      {open && tool.name !== 'Bash' && tool.input && (
        <pre style={styles.toolInput}>{JSON.stringify(tool.input, null, 2).slice(0, 600)}</pre>
      )}
    </div>
  )
}

function summarizeTool(t) {
  if (t.name === 'Bash') {
    const cmd = t.input?.command || ''
    // First meaningful chunk: the command name + first arg or URL fragment.
    const firstLine = cmd.split('\n')[0].trim()
    return firstLine.length > 60 ? firstLine.slice(0, 60) + '…' : firstLine
  }
  if (t.name === 'Read' || t.name === 'Write' || t.name === 'Edit') {
    return t.input?.file_path?.split('/').slice(-2).join('/') || ''
  }
  if (t.name === 'Grep' || t.name === 'Glob') {
    return t.input?.pattern || ''
  }
  return ''
}

function ToolResultChip({ results }) {
  const [open, setOpen] = useState(false)
  const first = results?.[0]
  const outStr = typeof first?.output === 'string' ? first.output : JSON.stringify(first?.output || '')
  const bytes = outStr.length
  const preview = outStr.slice(0, 80).replace(/\s+/g, ' ')
  return (
    <div style={styles.toolCall}>
      <button onClick={() => setOpen(o => !o)} style={styles.toolChip} type="button">
        <span style={styles.toolChipIcon}>{open ? '▾' : '▸'}</span>
        <code style={styles.toolName}>result</code>
        <span style={styles.toolChipSummary}>{bytes} chars · {preview}</span>
      </button>
      {open && results?.map((r, i) => (
        <pre key={i} style={styles.toolInput}>{typeof r.output === 'string' ? r.output.slice(0, 1200) : JSON.stringify(r.output, null, 2).slice(0, 1200)}</pre>
      ))}
    </div>
  )
}

// Rotating fallback labels for the gap moments (Claude reasoning with no
// active tool call). Cycles every 2.5s so "thinking…" doesn't feel frozen
// when a response takes a while. Pool kept varied but short.
const THINKING_LABELS = [
  'thinking…',
  'working through the request…',
  'reasoning…',
  'pulling context together…',
  'planning next step…',
  'reviewing project details…',
  'almost there…'
]
function useThinkingLabel() {
  const [i, setI] = useState(0)
  useEffect(() => {
    const id = setInterval(() => setI(n => (n + 1) % THINKING_LABELS.length), 2500)
    return () => clearInterval(id)
  }, [])
  return THINKING_LABELS[i]
}

// Human-readable one-liner for the live "⟳ …" status while a tool is
// in flight. Falls back to the raw tool name if we don't have a nicer
// label. Tool inputs are trimmed aggressively — this is a single line.
function formatToolStatus({ name, input }) {
  const short = (s, n = 60) => {
    const str = String(s || '').replace(/\s+/g, ' ').trim()
    return str.length > n ? str.slice(0, n) + '…' : str
  }
  if (!name) return 'working…'

  if (name === 'Bash') {
    const full = String(input?.command || '')
    // Strip leading env-var chains like `TOKEN="eyJhbG…" && curl …` so the
    // status doesn't surface a 200-char JWT before the real command.
    const stripped = full.replace(/^(?:\s*[A-Z_][A-Z0-9_]*=(?:"[^"]*"|'[^']*'|\S+)\s*(?:&&|;)\s*)+/, '')
    // Match on the FULL command, not the truncated display version, so long
    // tokens don't hide the keyword.
    if (/\bcurl\b/i.test(full)) {
      if (/auth\/v\d\/token|\/token\b/i.test(full)) return 'getting SFMC OAuth token…'
      if (/\/asset\/v\d\/content\/assets\/(\d+)/i.test(full)) {
        const id = full.match(/\/asset\/v\d\/content\/assets\/(\d+)/i)[1]
        return `fetching SFMC asset ${id}…`
      }
      if (/dataextension|\/data\/v\d/i.test(full)) return 'querying Data Extension…'
      if (/journey|interaction/i.test(full)) return 'reading journey from SFMC…'
      // Last-resort: show the URL path, not the whole curl invocation.
      const urlMatch = full.match(/https?:\/\/[^\s"']+/)
      if (urlMatch) {
        try {
          const u = new URL(urlMatch[0])
          return `calling ${u.hostname}${short(u.pathname, 40)}`
        } catch { /* fall through */ }
      }
      return `calling SFMC: ${short(stripped, 60)}`
    }
    return `running: ${short(stripped, 70)}`
  }
  if (name === 'Read')     return `reading ${short(input?.file_path, 50)}`
  if (name === 'Write')    return `writing ${short(input?.file_path, 50)}`
  if (name === 'Edit')     return `editing ${short(input?.file_path, 50)}`
  if (name === 'Glob')     return `searching files (${short(input?.pattern, 40)})`
  if (name === 'Grep')     return `searching "${short(input?.pattern, 40)}"`
  if (name === 'WebFetch') return `fetching ${short(input?.url, 60)}`

  // Delma MCP tools surface as mcp__delma__<op>. Strip the prefix and
  // convert snake_case → friendly English.
  if (name.startsWith('mcp__delma__')) {
    const op = name.slice('mcp__delma__'.length)
    const labels = {
      delma_add_playbook_rule: 'saving to General Patterns',
      delma_arch_set_node_note: 'updating a diagram node note',
      delma_arch_set_node_description: 'updating a diagram node description',
      delma_arch_set_node_label: 'renaming a diagram node',
      delma_arch_add_node: 'adding a diagram node',
      delma_arch_remove_node: 'removing a diagram node',
      delma_add_decision: 'saving to Project Details',
      delma_set_environment_key: 'updating Files Locations & Keys',
      delma_add_person: 'adding someone to People',
      delma_add_action: 'adding an action item',
      delma_complete_action: 'completing an action',
      append_memory_note: 'saving a note',
      sync_conversation_summary: 'summarizing the conversation',
      save_diagram_view: 'saving the diagram'
    }
    return labels[op] || `Delma: ${op.replace(/_/g, ' ')}`
  }

  return `${name}…`
}

// Pattern-match the agent's closing question to decide whether to offer
// Yes/No buttons. Conservative: only on first-person-action proposals
// ("Should I …?", "Want me to …?", "Add this to X?") — never on open-ended
// "What would you like to do?" / "How should I proceed?" questions.
function isYesNoQuestion(text) {
  if (!text) return false
  const last = text.trim().split(/\n\s*\n/).pop() || ''
  const tail = last.trim()
  if (!tail.endsWith('?')) return false
  // First-person proposal verbs (Claude proposing an action it'd take).
  // Narrowed "do you want" / "would you like" to require "me to" so they
  // don't match "what would you like me to do?"-style open questions.
  const proposalVerbs = /(want me to|should i|shall i|do you want me to|would you like me to|ok (?:to|if i)|go ahead)/i
  // Save-location proposals: "Add this to General Patterns?", "Save it
  // under the EMAIL node?" — the explicit-destination variant we see when
  // the user dumps knowledge and Claude offers to file it.
  const saveLocation = /\b(?:add|save|put|write|file|stash) (?:this|it|that) (?:to|in|under|on|as)\b/i
  return proposalVerbs.test(tail) || saveLocation.test(tail)
}

// Post-turn suggestion card. After each exchange, the server parses a
// <delma-suggest> block from Claude's response and pushes one of these per
// proposed save. The user reads the human summary, clicks Yes to apply or
// No to dismiss. Nothing writes until Yes.
function SuggestionCard({ suggestion, onApply, onDismiss }) {
  const [busy, setBusy] = useState(false)
  const click = (fn) => {
    if (busy) return
    setBusy(true)
    fn()
  }
  return (
    <div style={styles.suggestCard}>
      <div style={styles.suggestPrompt}>
        Should we update <strong>{suggestion.tab}</strong>?
      </div>
      <div style={styles.suggestSummary}>{suggestion.summary}</div>
      <div style={{ display: 'flex', gap: 8, marginTop: 10 }}>
        <button disabled={busy} onClick={() => click(onApply)} style={styles.yesBtn}>Yes, update</button>
        <button disabled={busy} onClick={() => click(onDismiss)} style={styles.noBtn}>No</button>
      </div>
    </div>
  )
}

function YesNoButtons({ onAnswer }) {
  return (
    <div style={{ display: 'flex', gap: 8, marginTop: 10 }}>
      <button onClick={() => onAnswer('yes')} style={styles.yesBtn}>Yes</button>
      <button onClick={() => onAnswer('no')} style={styles.noBtn}>No</button>
    </div>
  )
}

function MessageBubble({ msg, isLatestAssistant, onAnswer }) {
  if (msg.role === 'user') {
    return (
      <div style={{ ...styles.bubble, ...styles.userBubble }}>
        <div style={styles.roleLabel}>you</div>
        <div>{msg.content}</div>
      </div>
    )
  }
  if (msg.role === 'assistant') {
    const hasText = msg.content?.trim()
    if (!hasText) return null
    return (
      <div style={{ ...styles.bubble, ...styles.assistantBubble }}>
        <div style={styles.roleLabel}>claude</div>
        <div
          className="delma-chat-md"
          dangerouslySetInnerHTML={{ __html: renderChatMarkdown(msg.content) }}
        />
        {isLatestAssistant && isYesNoQuestion(msg.content) && (
          <YesNoButtons onAnswer={(ans) => onAnswer(ans)} />
        )}
      </div>
    )
  }
  // Tool calls + tool results live in console/server logs, not in the chat UI.
  if (msg.role === 'tool') return null
  if (msg.role === 'system') {
    return (
      <div style={{ ...styles.bubble, ...styles.systemBubble }}>
        <div style={styles.roleLabel}>system</div>
        <div>{msg.content}</div>
      </div>
    )
  }
  return null
}

const styles = {
  container: {
    display: 'flex', flexDirection: 'column', height: '100%', width: '100%',
    background: '#FFFEEE', borderLeft: '1px solid #E8D8D2',
    fontFamily: '-apple-system, system-ui, sans-serif', color: '#1F1A1A'
  },
  header: {
    padding: '12px 16px', borderBottom: '1px solid #E8D8D2', display: 'flex',
    justifyContent: 'space-between', alignItems: 'center', fontSize: 13
  },
  stopBtn: {
    background: '#8F0000', color: '#fff', border: 'none', borderRadius: 4,
    padding: '4px 10px', fontSize: 11, cursor: 'pointer'
  },
  clearBtn: {
    background: 'transparent', color: '#6B5A5A', border: '1px solid #E8D8D2',
    borderRadius: 4, padding: '4px 10px', fontSize: 11, cursor: 'pointer'
  },
  toolbar: {
    padding: '8px 14px', borderTop: '1px solid #E8D8D2',
    display: 'flex', gap: 8
  },
  newEmailBtn: {
    background: '#8F0000', color: '#fff', border: 'none',
    borderRadius: 6, padding: '8px 14px', fontSize: 12, fontWeight: 600,
    cursor: 'pointer', display: 'inline-flex', alignItems: 'center',
    letterSpacing: '0.02em'
  },
  messages: { flex: 1, overflowY: 'auto', padding: '12px 14px' },
  empty: { color: '#6B5A5A', fontSize: 13, fontStyle: 'italic', padding: '20px 0' },
  bubble: { marginBottom: 12, fontSize: 13, lineHeight: 1.5 },
  userBubble: { maxWidth: '85%', background: '#F4F0EA', borderRadius: 10, padding: '8px 10px' },
  assistantBubble: { marginLeft: 'auto', maxWidth: '85%' },
  toolBubble: { opacity: 0.7 },
  systemBubble: { color: '#8F0000' },
  roleLabel: {
    fontSize: 10, textTransform: 'uppercase', letterSpacing: '0.06em',
    color: '#6B5A5A', marginBottom: 4
  },
  toolsList: { marginTop: 8, paddingLeft: 8, borderLeft: '2px solid #E8D8D2' },
  toolCall: { marginBottom: 4 },
  toolChip: {
    display: 'flex', alignItems: 'center', gap: 6, width: '100%',
    padding: '4px 6px', background: 'transparent', border: 'none',
    borderRadius: 4, cursor: 'pointer', fontSize: 11, color: '#6B5A5A',
    textAlign: 'left', fontFamily: 'inherit'
  },
  toolChipIcon: {
    fontSize: 9, color: '#B9ADA8', width: 10, flexShrink: 0
  },
  toolChipSummary: {
    color: '#6B5A5A', fontSize: 11, overflow: 'hidden',
    textOverflow: 'ellipsis', whiteSpace: 'nowrap', minWidth: 0, flex: 1
  },
  toolName: {
    fontSize: 10, background: '#F4F0EA', padding: '2px 6px',
    borderRadius: 3, fontFamily: 'ui-monospace, monospace', color: '#6B4823',
    flexShrink: 0
  },
  toolInput: {
    background: '#F4F0EA', padding: 6, borderRadius: 4, fontSize: 11,
    margin: '4px 0 0', maxHeight: 120, overflow: 'auto', whiteSpace: 'pre-wrap',
    fontFamily: 'ui-monospace, monospace'
  },
  thinking: { color: '#6B5A5A', fontSize: 12, fontStyle: 'italic', padding: '8px 0' },
  resizeHandle: {
    height: 6, cursor: 'ns-resize', background: 'transparent',
    borderTop: '1px solid #E8D8D2', flexShrink: 0
  },
  inputRow: { padding: 10, display: 'flex', gap: 8, flexShrink: 0 },
  input: {
    flex: 1, border: '1px solid #E8D8D2', borderRadius: 8, padding: '8px 10px',
    fontSize: 13, background: '#FFFFFF', resize: 'none', fontFamily: 'inherit', color: '#1F1A1A',
    height: '100%', boxSizing: 'border-box'
  },
  sendBtn: {
    background: '#8F0000', color: '#fff', border: 'none', borderRadius: 999,
    padding: '0 18px', height: 36, fontSize: 13, fontWeight: 600,
    cursor: 'pointer', alignSelf: 'flex-end', flexShrink: 0
  },
  yesBtn: {
    background: '#2F6B5A', color: '#fff', border: 'none', borderRadius: 999,
    padding: '6px 18px', fontSize: 12, fontWeight: 600, cursor: 'pointer'
  },
  noBtn: {
    background: '#8F0000', color: '#fff', border: 'none', borderRadius: 999,
    padding: '6px 18px', fontSize: 12, fontWeight: 600, cursor: 'pointer'
  },
  suggestCard: {
    margin: '10px 0',
    padding: '12px 14px',
    background: '#FFFEEE',
    border: '1.5px solid #8F0000',
    borderRadius: 10,
    boxShadow: '0 2px 6px rgba(143, 0, 0, 0.08)'
  },
  suggestPrompt: {
    fontSize: 13,
    color: '#4a3a3a',
    marginBottom: 4
  },
  suggestSummary: {
    fontSize: 14,
    color: '#1a1a1a',
    lineHeight: 1.4
  }
}
