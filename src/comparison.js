/**
 * comparison.js — Single-agent Claude call, streamed in real time.
 */

import { SINGLE_CLAUDE } from './prompts.js'

export async function runComparison(query) {
  const statusEl = document.getElementById('claude-status')
  const bodyEl   = document.getElementById('claude-body')
  const timeEl   = document.getElementById('claude-time')

  statusEl.innerHTML = '<span class="comp-dot"></span> Thinking...'
  statusEl.classList.add('active')
  bodyEl.textContent = ''
  timeEl.textContent = ''

  const t0 = Date.now()

  let response
  try {
    response = await fetch('/api/chat-stream', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ system: SINGLE_CLAUDE, user: query })
    })
  } catch (e) {
    statusEl.innerHTML = 'Error'
    statusEl.classList.remove('active')
    bodyEl.textContent = 'Network error: ' + e.message
    return
  }

  if (!response.ok) {
    statusEl.innerHTML = 'Error'
    statusEl.classList.remove('active')
    bodyEl.textContent = 'API error ' + response.status
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

      // SSE is newline-delimited — process complete lines
      const lines = buf.split('\n')
      buf = lines.pop()   // keep the incomplete trailing chunk

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
          bodyEl.textContent += evt.delta.text
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
