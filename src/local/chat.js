// Chat panel: renders the message list + suggestion cards, streams the
// turn via SSE, posts user/dismiss decisions, and notifies the parent
// when a saved suggestion changes CLAUDE.md so the workspace can
// re-render the affected section.

import { marked } from 'marked'
import { escapeHtml, parseSseFrame } from './util.js'

export function initChat({ els, getPath, onDocUpdated }) {
  let messages = []
  let streaming = false
  let abortCtrl = null
  let pending = []

  async function load() {
    messages = []
    pending = []
    try {
      const res = await fetch(`/api/local/chat/history?path=${encodeURIComponent(getPath())}`)
      const data = await res.json()
      messages = (data.messages || []).map(m => ({ role: m.role, content: m.content }))
    } catch { /* empty history is fine */ }
    render()
  }

  function render() {
    const frag = document.createDocumentFragment()
    for (const m of messages) {
      const bubble = document.createElement('div')
      bubble.className = `chat-bubble ${m.role}`
      if (m.role === 'assistant') bubble.innerHTML = marked.parse(m.content || '')
      else bubble.textContent = m.content || ''
      frag.appendChild(bubble)
    }
    for (const s of pending) frag.appendChild(buildSuggestionCard(s))
    if (streaming) {
      const t = document.createElement('div')
      t.className = 'chat-thinking'
      t.textContent = 'Claude is thinking…'
      frag.appendChild(t)
    }
    els.chatMessages.innerHTML = ''
    els.chatMessages.appendChild(frag)
    els.chatMessages.scrollTop = els.chatMessages.scrollHeight
  }

  function buildSuggestionCard(s) {
    const card = document.createElement('div')
    card.className = 'chat-suggest-card'
    card.innerHTML = `
      <div class="chat-suggest-prompt">Should we update <strong>${escapeHtml(s.tab)}</strong>?</div>
      <div class="chat-suggest-summary">${escapeHtml(s.summary)}</div>
      <div class="chat-suggest-buttons">
        <button class="btn-yes">Yes, update</button>
        <button class="btn-no">No</button>
      </div>`
    card.querySelector('.btn-yes').addEventListener('click', () => decide(s.id, 'apply'))
    card.querySelector('.btn-no').addEventListener('click', () => decide(s.id, 'dismiss'))
    return card
  }

  async function decide(id, action) {
    const endpoint = action === 'apply'
      ? '/api/local/chat/apply-suggestion'
      : '/api/local/chat/dismiss-suggestion'
    try {
      await fetch(endpoint, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ path: getPath(), id })
      })
    } catch (err) { console.warn('[local-chat] decide failed:', err.message) }
    pending = pending.filter(s => s.id !== id)
    if (action === 'apply') await onDocUpdated()
    render()
  }

  async function send() {
    const text = els.chatInput.value.trim()
    if (!text || streaming) return
    els.chatInput.value = ''
    messages.push({ role: 'user', content: text })
    streaming = true
    render()

    const ctrl = new AbortController()
    abortCtrl = ctrl
    let assistantBubble = null
    try {
      const res = await fetch('/api/local/chat/stream', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ path: getPath(), message: text }),
        signal: ctrl.signal
      })
      if (!res.ok || !res.body) throw new Error(`stream failed: ${res.status}`)
      const reader = res.body.getReader()
      const decoder = new TextDecoder()
      let buf = ''
      while (true) {
        const { value, done } = await reader.read()
        if (done) break
        buf += decoder.decode(value, { stream: true })
        let idx
        while ((idx = buf.indexOf('\n\n')) !== -1) {
          const frame = buf.slice(0, idx); buf = buf.slice(idx + 2)
          const parsed = parseSseFrame(frame)
          if (!parsed) continue
          if (parsed.event === 'message') {
            const m = parsed.data
            if (m?.type === 'assistant' && Array.isArray(m.message?.content)) {
              for (const c of m.message.content) {
                if (c.type === 'text' && typeof c.text === 'string') {
                  if (!assistantBubble) {
                    assistantBubble = { role: 'assistant', content: '' }
                    messages.push(assistantBubble)
                  }
                  assistantBubble.content += c.text
                  render()
                }
              }
            }
          } else if (parsed.event === 'suggestions') {
            const items = parsed.data?.items || []
            pending.push(...items)
            render()
          } else if (parsed.event === 'error') {
            messages.push({ role: 'assistant', content: `**Error:** ${parsed.data?.message || 'unknown'}` })
            render()
          }
        }
      }
    } catch (err) {
      if (err.name !== 'AbortError') {
        messages.push({ role: 'assistant', content: `**Error:** ${err.message}` })
      }
    } finally {
      streaming = false
      abortCtrl = null
      render()
    }
  }

  async function clear() {
    if (!confirm('Clear the chat history for this project?')) return
    try {
      await fetch('/api/local/chat/clear', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ path: getPath() })
      })
    } catch { /* best-effort */ }
    messages = []; pending = []
    render()
  }

  els.chatSendBtn.addEventListener('click', send)
  els.chatInput.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) send()
  })
  els.chatClearBtn.addEventListener('click', clear)

  return { load }
}
