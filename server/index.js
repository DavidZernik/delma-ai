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
  const { system, user } = req.body

  if (!process.env.ANTHROPIC_API_KEY) {
    return res.status(500).json({ error: 'ANTHROPIC_API_KEY not set in .env' })
  }

  res.setHeader('Content-Type', 'text/event-stream')
  res.setHeader('Cache-Control', 'no-cache')
  res.setHeader('Connection', 'keep-alive')

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
        model: 'claude-opus-4-5',
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

  // Pipe SSE stream straight through to the client
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
