// Delma cloud backend. Two jobs only: identity (Supabase Auth) and Anthropic
// API proxy. No project storage, no sync, no agent execution. Files live on
// the user's disk; this server just lets them sign in once and stop pasting
// API keys.
//
// Deployed to Railway/Fly/etc. as a separate service from the local Delma
// app (which still runs on the user's 127.0.0.1).
//
//   POST /v1/messages   — Anthropic proxy. Validates Delma JWT, applies
//                         rate limit, forwards to api.anthropic.com,
//                         streams response, logs usage on completion.
//   GET  /healthz       — liveness probe.
//   GET  /v1/me         — sanity check: returns the authenticated user.

import express from 'express'
import { config } from 'dotenv'
import { createClient } from '@supabase/supabase-js'

config({ override: true })

// Railway / Fly / Render all set PORT; locally we use CLOUD_PORT to avoid
// colliding with the local Delma server on 3001.
const PORT = Number(process.env.PORT || process.env.CLOUD_PORT || 3002)
const ANTHROPIC_URL = 'https://api.anthropic.com'
const ANTHROPIC_KEY = process.env.ANTHROPIC_API_KEY
const SUPABASE_URL = process.env.SUPABASE_URL
const SUPABASE_SERVICE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY
const DAILY_INPUT_TOKEN_CAP = Number(process.env.CLOUD_DAILY_TOKEN_CAP || 1_000_000)

if (!ANTHROPIC_KEY) console.warn('[cloud] ANTHROPIC_API_KEY missing — proxy will 500')
if (!SUPABASE_URL || !SUPABASE_SERVICE_KEY) console.warn('[cloud] Supabase env missing — auth will 401 every request')

// Service-role client. Bypasses RLS for inserts into usage_log and reads of
// auth.users via getUser(jwt). Never expose the service key over the wire.
const supabase = createClient(SUPABASE_URL || '', SUPABASE_SERVICE_KEY || '', {
  auth: { persistSession: false, autoRefreshToken: false }
})

const app = express()
app.use(express.json({ limit: '4mb' }))

app.get('/healthz', (req, res) => res.json({ ok: true, ts: Date.now() }))

// Pulls the bearer / x-api-key token. The Anthropic SDK sends it as
// `x-api-key`; clients hitting us directly may use `authorization: Bearer`.
function extractToken(req) {
  const auth = req.get('authorization') || ''
  if (auth.toLowerCase().startsWith('bearer ')) return auth.slice(7).trim()
  return req.get('x-api-key') || ''
}

// Validates the token against Supabase Auth, checks the user isn't disabled,
// and attaches { id, email } to req.user. Sets the response and returns
// false on failure so the caller can stop processing.
async function authenticate(req, res) {
  const token = extractToken(req)
  if (!token) {
    res.status(401).json({ type: 'error', error: { type: 'authentication_error', message: 'missing token' } })
    return false
  }
  const { data, error } = await supabase.auth.getUser(token)
  if (error || !data?.user) {
    res.status(401).json({ type: 'error', error: { type: 'authentication_error', message: 'invalid token' } })
    return false
  }
  if (data.user.app_metadata?.disabled) {
    res.status(403).json({ type: 'error', error: { type: 'permission_error', message: 'account disabled' } })
    return false
  }
  req.user = { id: data.user.id, email: data.user.email }
  return true
}

// Rate-limit check: sum input_tokens over the last 24h. Cheap; usage_log is
// indexed on (user_id, ts DESC). 429 with the same shape Anthropic uses.
async function checkRateLimit(req, res) {
  const since = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString()
  const { data, error } = await supabase
    .from('usage_log')
    .select('input_tokens')
    .eq('user_id', req.user.id)
    .gte('ts', since)
  if (error) {
    console.error('[cloud] rate limit query failed:', error.message)
    return true // fail open — better to allow than to block when Postgres is flaky
  }
  const used = (data || []).reduce((sum, row) => sum + (row.input_tokens || 0), 0)
  if (used >= DAILY_INPUT_TOKEN_CAP) {
    res.status(429).json({
      type: 'error',
      error: { type: 'rate_limit_error', message: `daily token cap reached (${used}/${DAILY_INPUT_TOKEN_CAP}). resets in 24h.` }
    })
    return false
  }
  return true
}

app.get('/v1/me', async (req, res) => {
  if (!(await authenticate(req, res))) return
  res.json({ id: req.user.id, email: req.user.email })
})

// Anthropic proxy. Streams when the body says stream:true, returns JSON
// otherwise. Either way we log usage after the upstream finishes.
app.post('/v1/messages', async (req, res) => {
  if (!(await authenticate(req, res))) return
  if (!(await checkRateLimit(req, res))) return

  const body = req.body || {}
  const wantsStream = !!body.stream
  const model = body.model || 'unknown'

  let upstream
  try {
    upstream = await fetch(`${ANTHROPIC_URL}/v1/messages`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': ANTHROPIC_KEY,
        'anthropic-version': req.get('anthropic-version') || '2023-06-01',
        'anthropic-beta': req.get('anthropic-beta') || ''
      },
      body: JSON.stringify(body)
    })
  } catch (err) {
    console.error('[cloud] upstream fetch failed:', err.message)
    return res.status(502).json({ type: 'error', error: { type: 'api_error', message: `upstream unreachable: ${err.message}` } })
  }

  res.status(upstream.status)
  for (const [k, v] of upstream.headers.entries()) {
    if (k.toLowerCase() === 'transfer-encoding') continue // node manages this itself
    res.setHeader(k, v)
  }

  // Bookkeeping: as the body flies past us, track token counts from
  // Anthropic's SSE events so we can append a usage_log row at the end.
  let inputTokens = 0
  let outputTokens = 0
  let buf = ''

  function consumeSseChunk(chunk) {
    buf += chunk
    let idx
    while ((idx = buf.indexOf('\n\n')) !== -1) {
      const frame = buf.slice(0, idx); buf = buf.slice(idx + 2)
      const dataLine = frame.split('\n').find(l => l.startsWith('data:'))
      if (!dataLine) continue
      try {
        const payload = JSON.parse(dataLine.slice(5).trim())
        if (payload.type === 'message_start' && payload.message?.usage) {
          inputTokens = payload.message.usage.input_tokens || 0
          outputTokens = payload.message.usage.output_tokens || 0
        } else if (payload.type === 'message_delta' && payload.usage) {
          if (payload.usage.output_tokens != null) outputTokens = payload.usage.output_tokens
        }
      } catch { /* not JSON, ignore */ }
    }
  }

  async function logUsage() {
    try {
      await supabase.from('usage_log').insert({
        user_id: req.user.id,
        endpoint: '/v1/messages',
        model,
        input_tokens: inputTokens,
        output_tokens: outputTokens,
        status: upstream.status
      })
    } catch (err) {
      console.error('[cloud] usage log insert failed:', err.message)
    }
  }

  if (!upstream.body) { res.end(); await logUsage(); return }

  const reader = upstream.body.getReader()
  const decoder = new TextDecoder()
  try {
    while (true) {
      const { value, done } = await reader.read()
      if (done) break
      const chunk = decoder.decode(value, { stream: true })
      if (wantsStream) consumeSseChunk(chunk)
      else buf += chunk
      res.write(value)
    }
  } catch (err) {
    console.error('[cloud] stream pump failed:', err.message)
  } finally {
    res.end()
  }

  // Non-streaming responses: pull token counts from the final JSON body.
  if (!wantsStream && buf) {
    try {
      const payload = JSON.parse(buf)
      inputTokens = payload?.usage?.input_tokens || inputTokens
      outputTokens = payload?.usage?.output_tokens || outputTokens
    } catch { /* upstream returned non-JSON, leave counts at 0 */ }
  }

  await logUsage()
})

app.listen(PORT, '0.0.0.0', () => {
  console.log(`Delma cloud backend listening on :${PORT}`)
})
