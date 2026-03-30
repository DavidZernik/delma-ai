/**
 * comparison.js — Direct model call, streamed in real time.
 * Reads the selected model from #model-select and routes accordingly.
 */

import { SINGLE_CLAUDE } from './prompts.js'

const MODEL_LABELS = {
  'claude-sonnet-4-20250514': 'Claude Sonnet',
  'gpt-4o': 'GPT-4o'
}

export async function runComparison(query) {
  const statusEl     = document.getElementById('claude-status')
  const bodyEl       = document.getElementById('claude-body')
  const timeEl       = document.getElementById('claude-time')
  const labelEl      = document.getElementById('direct-model-label')
  const modelSelect  = document.getElementById('model-select')
  const model        = modelSelect?.value || 'claude-sonnet-4-20250514'

  if (labelEl) labelEl.textContent = MODEL_LABELS[model] || model

  // Append a new conversation turn
  const turnEl = document.createElement('div')
  turnEl.className = 'turn'
  const userMsgEl = document.createElement('div')
  userMsgEl.className = 'user-msg'
  userMsgEl.textContent = query
  const responseEl = document.createElement('div')
  responseEl.className = 'response-text'
  turnEl.appendChild(userMsgEl)
  turnEl.appendChild(responseEl)
  bodyEl.appendChild(turnEl)
  bodyEl.scrollTop = bodyEl.scrollHeight

  statusEl.innerHTML = '<span class="comp-dot"></span> Thinking...'
  statusEl.classList.add('active')
  timeEl.textContent = ''

  const t0 = Date.now()

  let response
  try {
    response = await fetch('/api/chat-stream', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ system: SINGLE_CLAUDE, user: query, model })
    })
  } catch (e) {
    statusEl.innerHTML = 'Error'
    statusEl.classList.remove('active')
    responseEl.textContent = 'Network error: ' + e.message
    return
  }

  if (!response.ok) {
    statusEl.innerHTML = 'Error'
    statusEl.classList.remove('active')
    responseEl.textContent = 'API error ' + response.status
    return
  }

  // Stream SSE events
  const reader  = response.body.getReader()
  const decoder = new TextDecoder()
  let buf = ''
  let started = false

  try {
    while (true) {
      const { done, value } = await reader.read()
      if (done) break

      buf += decoder.decode(value, { stream: true })

      const lines = buf.split('\n')
      buf = lines.pop()

      for (const line of lines) {
        if (!line.startsWith('data: ')) continue
        const raw = line.slice(6).trim()
        if (raw === '[DONE]') continue

        let evt
        try { evt = JSON.parse(raw) } catch { continue }

        if (evt.type === 'content_block_delta' && evt.delta?.type === 'text_delta') {
          if (!started) {
            statusEl.innerHTML = '<span class="comp-writing">&#9632;</span> Writing...'
            started = true
          }
          responseEl.textContent += evt.delta.text
          bodyEl.scrollTop = bodyEl.scrollHeight
        }
      }
    }
  } catch (_) {}

  const elapsed = ((Date.now() - t0) / 1000).toFixed(1)
  statusEl.innerHTML = '<span class="comp-done">&#10003;</span> Complete'
  statusEl.classList.remove('active')
  timeEl.textContent = `${elapsed}s · single call`
}
