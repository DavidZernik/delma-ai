/**
 * api.js — LLM API client layer.
 *
 * callClaude     — returns parsed JSON from the model response
 * callClaudeWithRetry — one automatic retry on failure
 */

export const SONNET      = 'claude-sonnet-4-20250514'
export const HAIKU       = 'claude-haiku-4-5-20251001'
export const DEEPSEEK_V3 = 'deepseek-chat'
export const GPT4O       = 'gpt-4o'
export const GPT4O_MINI  = 'gpt-4o-mini'

// Timeout per model tier
const TIMEOUT_MS = { [HAIKU]: 55000, [SONNET]: 120000, [DEEPSEEK_V3]: 60000, [GPT4O]: 120000, [GPT4O_MINI]: 55000 }
// Max tokens per model tier
const MAX_TOKENS = { [HAIKU]: 6000, [SONNET]: 8000, [DEEPSEEK_V3]: 8000, [GPT4O]: 8000, [GPT4O_MINI]: 6000 }

async function _post(body, signal) {
  let response
  try {
    response = await fetch('/api/chat', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
      signal
    })
  } catch (e) {
    if (e.name === 'AbortError') throw new Error('Request timed out')
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
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeoutMs)

  try {
    const text = await _post({
      system: systemPrompt,
      user: typeof userMessage === 'string' ? userMessage : JSON.stringify(userMessage, null, 2),
      model,
      max_tokens: Math.min(maxTokens || MAX_TOKENS[model] || 1500, MAX_TOKENS[model] || 8192)
    }, controller.signal)

    return extractJSON(text)
  } finally {
    clearTimeout(timer)
  }
}

export async function callClaudeWithRetry(systemPrompt, userMessage, onRetry, model = SONNET, maxTokens) {
  try {
    return await callClaude(systemPrompt, userMessage, model, maxTokens)
  } catch (firstErr) {
    console.warn('API call failed, retrying…', firstErr.message)
    if (onRetry) onRetry()
    await new Promise(r => setTimeout(r, 2000))
    try {
      return await callClaude(systemPrompt, userMessage, model, maxTokens)
    } catch (secondErr) {
      console.error('Retry also failed:', secondErr.message)
      throw new Error(`Both attempts failed: ${firstErr.message} → ${secondErr.message}`)
    }
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
