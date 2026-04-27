// Small DOM + HTML helpers shared across the local-mode modules. Nothing
// stateful — pure functions for escaping, parsing SSE frames, etc.

export function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, c =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]))
}

export function escapeAttr(s) { return escapeHtml(s).replace(/"/g, '&quot;') }

// Parse a single SSE frame ("event: …\ndata: …") into { event, data }.
// Returns null for frames that have no data line (heartbeat pings, etc).
export function parseSseFrame(frame) {
  const lines = frame.split('\n')
  let event = 'message'
  const dataLines = []
  for (const l of lines) {
    if (l.startsWith('event:')) event = l.slice(6).trim()
    else if (l.startsWith('data:')) dataLines.push(l.slice(5).trim())
  }
  if (!dataLines.length) return null
  try { return { event, data: JSON.parse(dataLines.join('\n')) } }
  catch { return null }
}
