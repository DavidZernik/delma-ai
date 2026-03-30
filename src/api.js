/**
 * callClaude — returns parsed JSON from the model response.
 * callClaudeRaw — returns raw text (for the comparison panel).
 */

export const SONNET     = 'claude-sonnet-4-20250514'
export const HAIKU      = 'claude-haiku-4-5-20251001'
export const DEEPSEEK_V3 = 'deepseek-chat'

// Timeout per model tier
const TIMEOUT_MS = { [HAIKU]: 55000, [SONNET]: 120000, [DEEPSEEK_V3]: 60000 }
// Max tokens per model tier
const MAX_TOKENS = { [HAIKU]: 6000, [SONNET]: 8000, [DEEPSEEK_V3]: 6000 }

async function _post(body) {
  let response
  try {
    response = await fetch('/api/chat', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body)
    })
  } catch (e) {
    throw new Error('Network error: ' + e.message)
  }

  if (!response.ok) {
    const text = await response.text().catch(() => response.statusText)
    throw new Error(`API ${response.status}: ${text}`)
  }

  const data = await response.json()
  if (!data.content?.[0]) throw new Error('Unexpected API response shape')
  return data.content[0].text
}

export async function callClaude(systemPrompt, userMessage, model = SONNET, maxTokens) {
  const timeoutMs = TIMEOUT_MS[model] || 20000
  const apiCall = _post({
    system: systemPrompt,
    user: typeof userMessage === 'string' ? userMessage : JSON.stringify(userMessage, null, 2),
    model,
    max_tokens: maxTokens || MAX_TOKENS[model] || 1500
  }).then(extractJSON)

  const timeout = new Promise((_, reject) =>
    setTimeout(() => reject(new Error(`Timeout after ${timeoutMs / 1000}s`)), timeoutMs)
  )

  return Promise.race([apiCall, timeout])
}

export async function callClaudeRaw(systemPrompt, userMessage) {
  return _post({
    system: systemPrompt,
    user: typeof userMessage === 'string' ? userMessage : JSON.stringify(userMessage, null, 2),
    max_tokens: 3000
  })
}

export async function callSearch(query, count = 5) {
  let response
  try {
    response = await fetch('/api/search', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ query, count })
    })
  } catch (e) {
    throw new Error('Search network error: ' + e.message)
  }

  if (!response.ok) {
    const text = await response.text().catch(() => response.statusText)
    throw new Error(`Search ${response.status}: ${text}`)
  }

  return response.json() // { context: string } — pre-chunked LLM context from Brave
}

export async function callClaudeWithRetry(systemPrompt, userMessage, onRetry, model = SONNET, maxTokens) {
  try {
    return await callClaude(systemPrompt, userMessage, model, maxTokens)
  } catch (firstErr) {
    console.warn('API call failed, retrying…', firstErr.message)
    if (onRetry) onRetry()
    await new Promise(r => setTimeout(r, 2000))
    return await callClaude(systemPrompt, userMessage, model, maxTokens)
  }
}

function extractJSON(text) {
  let s = text.trim()
  s = s.replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/i, '')
  const start = s.indexOf('{')
  const end   = s.lastIndexOf('}')
  if (start === -1 || end === -1 || end <= start) {
    throw new Error('No JSON object found in model response')
  }
  try {
    return JSON.parse(s.slice(start, end + 1))
  } catch (e) {
    throw new Error('Failed to parse model JSON: ' + e.message)
  }
}
