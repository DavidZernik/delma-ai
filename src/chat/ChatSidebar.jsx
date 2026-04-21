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
  const { messages, status, send, abort, clear } = useChatStream({ projectId, userId })
  const [input, setInput] = useState('')
  const [composerHeight, setComposerHeight] = useState(120)
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
          <button onClick={clear} style={styles.clearBtn}>Clear</button>
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
        {status === 'streaming' && <div style={styles.thinking}>⟳ thinking…</div>}
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

// Pattern-match the agent's closing question to decide whether to offer
// Yes/No buttons. Conservative: we want them on clear proposals, not on
// every "?" in the message (e.g. "How should I proceed?").
function isYesNoQuestion(text) {
  if (!text) return false
  const last = text.trim().split(/\n\s*\n/).pop() || ''
  if (!last.trim().endsWith('?')) return false
  return /(want me to|should i|shall i|do you want|would you like|ok to|go ahead)/i.test(last)
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
  }
}
