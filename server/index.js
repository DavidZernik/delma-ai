import express from 'express'
import { config } from 'dotenv'
import { fileURLToPath } from 'url'
import { dirname, join } from 'path'

config()

const __dirname = dirname(fileURLToPath(import.meta.url))

const app = express()
app.use(express.json({ limit: '2mb' }))

app.post('/api/chat', async (req, res) => {
  const { system, user, max_tokens } = req.body

  if (!process.env.ANTHROPIC_API_KEY) {
    return res.status(500).json({ error: 'ANTHROPIC_API_KEY not set in .env' })
  }

  let response
  try {
    response = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': process.env.ANTHROPIC_API_KEY,
        'anthropic-version': '2023-06-01'
      },
      body: JSON.stringify({
        model: req.body.model || 'claude-sonnet-4-20250514',
        max_tokens: max_tokens ?? 2000,
        system,
        messages: [{ role: 'user', content: user }]
      })
    })
  } catch (e) {
    return res.status(502).json({ error: 'Failed to reach Anthropic API: ' + e.message })
  }

  if (!response.ok) {
    const text = await response.text()
    return res.status(response.status).json({ error: text })
  }

  const data = await response.json()
  res.json(data)
})

// ── Streaming endpoint for the comparison panel ──────────────────────────
app.post('/api/chat-stream', async (req, res) => {
  const { system, user, model = 'claude-sonnet-4-20250514' } = req.body
  const isOpenAI = model.startsWith('gpt')

  res.setHeader('Content-Type', 'text/event-stream')
  res.setHeader('Cache-Control', 'no-cache')
  res.setHeader('Connection', 'keep-alive')

  if (isOpenAI) {
    if (!process.env.OPENAI_API_KEY) {
      res.write(`data: ${JSON.stringify({ error: 'OPENAI_API_KEY not set in .env' })}\n\n`)
      return res.end()
    }

    let upstream
    try {
      upstream = await fetch('https://api.openai.com/v1/chat/completions', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${process.env.OPENAI_API_KEY}`
        },
        body: JSON.stringify({
          model,
          max_tokens: 3000,
          stream: true,
          messages: [
            { role: 'system', content: system },
            { role: 'user', content: user }
          ]
        })
      })
    } catch (e) {
      res.write(`data: ${JSON.stringify({ error: e.message })}\n\n`)
      return res.end()
    }

    if (!upstream.ok) {
      const text = await upstream.text()
      res.write(`data: ${JSON.stringify({ error: text })}\n\n`)
      return res.end()
    }

    // Translate OpenAI SSE → Anthropic SSE format so the client stays unchanged
    const reader = upstream.body.getReader()
    const dec = new TextDecoder()
    let buf = ''
    try {
      while (true) {
        const { done, value } = await reader.read()
        if (done) break
        buf += dec.decode(value, { stream: true })
        const lines = buf.split('\n')
        buf = lines.pop()
        for (const line of lines) {
          if (!line.startsWith('data: ')) continue
          const raw = line.slice(6).trim()
          if (raw === '[DONE]') continue
          let evt
          try { evt = JSON.parse(raw) } catch { continue }
          const text = evt.choices?.[0]?.delta?.content
          if (text) {
            res.write(`data: ${JSON.stringify({ type: 'content_block_delta', delta: { type: 'text_delta', text } })}\n\n`)
          }
        }
      }
    } catch (_) {}
    return res.end()
  }

  // ── Anthropic streaming ───────────────────────────────────────────────────
  if (!process.env.ANTHROPIC_API_KEY) {
    res.write(`data: ${JSON.stringify({ error: 'ANTHROPIC_API_KEY not set in .env' })}\n\n`)
    return res.end()
  }

  let upstream
  try {
    upstream = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': process.env.ANTHROPIC_API_KEY,
        'anthropic-version': '2023-06-01'
      },
      body: JSON.stringify({
        model,
        max_tokens: 3000,
        stream: true,
        system,
        messages: [{ role: 'user', content: user }]
      })
    })
  } catch (e) {
    res.write(`data: ${JSON.stringify({ error: e.message })}\n\n`)
    return res.end()
  }

  if (!upstream.ok) {
    const text = await upstream.text()
    res.write(`data: ${JSON.stringify({ error: text })}\n\n`)
    return res.end()
  }

  // Pipe Anthropic SSE straight through
  const reader = upstream.body.getReader()
  const dec = new TextDecoder()
  try {
    while (true) {
      const { done, value } = await reader.read()
      if (done) break
      res.write(dec.decode(value, { stream: true }))
    }
  } catch (_) {}
  res.end()
})

// ── Web search endpoint ───────────────────────────────────────────────────────
app.post('/api/search', async (req, res) => {
  const { query, count = 5 } = req.body

  if (!process.env.BRAVE_API_KEY) {
    return res.status(500).json({ error: 'BRAVE_API_KEY not set in .env' })
  }

  let response
  try {
    response = await fetch(
      `https://api.search.brave.com/res/v1/web/search?q=${encodeURIComponent(query)}&count=${count}&result_filter=query`,
      {
        headers: {
          'Accept': 'application/json',
          'Accept-Encoding': 'gzip',
          'X-Subscription-Token': process.env.BRAVE_API_KEY
        }
      }
    )
  } catch (e) {
    return res.status(502).json({ error: 'Search request failed: ' + e.message })
  }

  if (!response.ok) {
    const text = await response.text()
    return res.status(response.status).json({ error: text })
  }

  const data = await response.json()
  // LLM Context endpoint returns pre-chunked relevance-scored context — pass through directly
  const context = data.query?.context
    || (data.web?.results || []).slice(0, count).map(r => `${r.title}: ${r.description || ''}`).join('\n')
  res.json({ context })
})

// Serve Vite build in production
if (process.env.NODE_ENV === 'production') {
  const dist = join(__dirname, '../dist')
  app.use(express.static(dist))
  app.get('*', (req, res) => res.sendFile(join(dist, 'index.html')))
}

const PORT = process.env.PORT || 3001
app.listen(PORT, () => console.log(`Server on http://localhost:${PORT}`))
