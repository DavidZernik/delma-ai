// Centralized LLM endpoint + headers so we can route all Anthropic calls
// through Helicone (or another proxy) via a single config flip.
//
// Activate Helicone: set HELICONE_API_KEY in your env. Every Anthropic call
// in the app starts routing through https://anthropic.helicone.ai, which
// logs latency, token usage, cost, and the full prompt/response to your
// Helicone dashboard. Zero code changes beyond importing from here.
//
// With no HELICONE_API_KEY set, everything goes direct to api.anthropic.com.

const HELICONE = process.env.HELICONE_API_KEY
export const ANTHROPIC_URL = HELICONE
  ? 'https://anthropic.helicone.ai/v1/messages'
  : 'https://api.anthropic.com/v1/messages'

// Build the headers for an Anthropic Messages call. Accepts an optional
// per-call tag that lands on the Helicone dashboard for filtering
// (e.g. 'critic', 'router', 'run-summary', 'narrative-sim').
export function anthropicHeaders(tag) {
  const h = {
    'Content-Type': 'application/json',
    'x-api-key': process.env.ANTHROPIC_API_KEY,
    'anthropic-version': '2023-06-01'
  }
  if (HELICONE) {
    h['Helicone-Auth'] = `Bearer ${HELICONE}`
    if (tag) h['Helicone-Property-Surface'] = tag
    h['Helicone-Cache-Enabled'] = 'false'  // our prompts vary every call
  }
  return h
}

// Small convenience wrapper around the Anthropic Messages API so callers
// don't have to hand-build fetch every time. Returns the parsed JSON or
// throws with status + first 200 chars of body.
export async function anthropicMessages(body, tag) {
  const res = await fetch(ANTHROPIC_URL, {
    method: 'POST',
    headers: anthropicHeaders(tag),
    body: JSON.stringify(body)
  })
  if (!res.ok) {
    const text = await res.text()
    throw new Error(`Anthropic ${res.status}${tag ? ` [${tag}]` : ''}: ${text.slice(0, 200)}`)
  }
  return res.json()
}
