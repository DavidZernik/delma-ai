// Minimal chat sidebar for Delma. Subscribes to /api/chat/stream via the
// custom useChatStream hook, renders messages + tool calls + input.
//
// Deliberately lightweight: no @assistant-ui yet. Once the end-to-end flow
// is proven, swap this rendering layer for assistant-ui to get markdown,
// code blocks, tool-call collapsing, etc. The hook interface is stable.

import React, { useEffect, useRef, useState } from 'react'
import { useChatStream } from './useChatStream.js'

export function ChatSidebar({ projectId, userId }) {
  const { messages, status, send, abort } = useChatStream({ projectId, userId })
  const [input, setInput] = useState('')
  const scrollRef = useRef(null)

  useEffect(() => {
    scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight, behavior: 'smooth' })
  }, [messages])

  const onSubmit = (e) => {
    e.preventDefault()
    const trimmed = input.trim()
    if (!trimmed || status === 'streaming') return
    setInput('')
    send(trimmed)
  }

  return (
    <div style={styles.container}>
      <div style={styles.header}>
        <strong>Delma Chat</strong>
        {status === 'streaming' && (
          <button onClick={abort} style={styles.stopBtn}>Stop</button>
        )}
      </div>

      <div ref={scrollRef} style={styles.messages}>
        {messages.length === 0 && (
          <div style={styles.empty}>
            Talk about your SFMC work. Claude has access to your Delma workspace + bash + file tools.
          </div>
        )}
        {messages.map(m => <MessageBubble key={m.id} msg={m} />)}
        {status === 'streaming' && <div style={styles.thinking}>⟳ thinking…</div>}
      </div>

      <form onSubmit={onSubmit} style={styles.inputRow}>
        <textarea
          value={input}
          onChange={e => setInput(e.target.value)}
          onKeyDown={e => {
            if (e.key === 'Enter' && !e.shiftKey) { onSubmit(e) }
          }}
          placeholder="Ask about your project, make changes, iterate…"
          disabled={status === 'streaming'}
          style={styles.input}
          rows={2}
        />
        <button type="submit" disabled={status === 'streaming' || !input.trim()} style={styles.sendBtn}>
          Send
        </button>
      </form>
    </div>
  )
}

function MessageBubble({ msg }) {
  if (msg.role === 'user') {
    return (
      <div style={{ ...styles.bubble, ...styles.userBubble }}>
        <div style={styles.roleLabel}>you</div>
        <div>{msg.content}</div>
      </div>
    )
  }
  if (msg.role === 'assistant') {
    return (
      <div style={{ ...styles.bubble, ...styles.assistantBubble }}>
        <div style={styles.roleLabel}>claude</div>
        <div style={{ whiteSpace: 'pre-wrap' }}>{msg.content}</div>
        {msg.tools?.length > 0 && (
          <div style={styles.toolsList}>
            {msg.tools.map(t => (
              <div key={t.id} style={styles.toolCall}>
                <code style={styles.toolName}>{t.name}</code>
                {t.name === 'Bash' && t.input?.command && (
                  <pre style={styles.toolInput}>{t.input.command}</pre>
                )}
              </div>
            ))}
          </div>
        )}
      </div>
    )
  }
  if (msg.role === 'tool') {
    return (
      <div style={{ ...styles.bubble, ...styles.toolBubble }}>
        <div style={styles.roleLabel}>tool result</div>
        {msg.results?.map((r, i) => (
          <pre key={i} style={styles.toolInput}>{typeof r.output === 'string' ? r.output.slice(0, 400) : JSON.stringify(r.output, null, 2)}</pre>
        ))}
      </div>
    )
  }
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
  messages: { flex: 1, overflowY: 'auto', padding: '12px 14px' },
  empty: { color: '#6B5A5A', fontSize: 13, fontStyle: 'italic', padding: '20px 0' },
  bubble: { marginBottom: 12, fontSize: 13, lineHeight: 1.5 },
  userBubble: { textAlign: 'right' },
  assistantBubble: {},
  toolBubble: { opacity: 0.7 },
  systemBubble: { color: '#8F0000' },
  roleLabel: {
    fontSize: 10, textTransform: 'uppercase', letterSpacing: '0.06em',
    color: '#6B5A5A', marginBottom: 4
  },
  toolsList: { marginTop: 8, paddingLeft: 8, borderLeft: '2px solid #E8D8D2' },
  toolCall: { marginBottom: 6 },
  toolName: {
    fontSize: 11, background: '#F4F0EA', padding: '2px 6px',
    borderRadius: 3, fontFamily: 'ui-monospace, monospace', color: '#6B4823'
  },
  toolInput: {
    background: '#F4F0EA', padding: 6, borderRadius: 4, fontSize: 11,
    margin: '4px 0 0', maxHeight: 120, overflow: 'auto', whiteSpace: 'pre-wrap',
    fontFamily: 'ui-monospace, monospace'
  },
  thinking: { color: '#6B5A5A', fontSize: 12, fontStyle: 'italic', padding: '8px 0' },
  inputRow: { borderTop: '1px solid #E8D8D2', padding: 10, display: 'flex', gap: 8 },
  input: {
    flex: 1, border: '1px solid #E8D8D2', borderRadius: 8, padding: '8px 10px',
    fontSize: 13, background: '#FFFFFF', resize: 'none', fontFamily: 'inherit', color: '#1F1A1A'
  },
  sendBtn: {
    background: '#8F0000', color: '#fff', border: 'none', borderRadius: 8,
    padding: '0 16px', fontSize: 13, cursor: 'pointer', alignSelf: 'stretch'
  }
}
