// Server log streaming: mirror every console.log/warn/error line to any
// connected browser via SSE. Lets the frontend show server-side traces
// ([delma inject], [chat] turn start, [delma WRITE], etc.) in DevTools
// alongside the normal frontend console output.
//
// Dev / debug only. Gated by DELMA_LOG_STREAM=1 or non-production NODE_ENV.
// Endpoint handler requires an authenticated session on top of that.

const RING_SIZE = 500
const ring = []            // [{ level, ts, line }]
const clients = new Set()  // SSE response objects

function pushLine(level, line) {
  const entry = { level, ts: Date.now(), line }
  ring.push(entry)
  if (ring.length > RING_SIZE) ring.shift()
  for (const res of clients) {
    try { res.write(`data: ${JSON.stringify(entry)}\n\n`) }
    catch { /* client probably gone; cleanup happens on 'close' */ }
  }
}

function formatArgs(args) {
  return args.map(a => {
    if (typeof a === 'string') return a
    try { return JSON.stringify(a) } catch { return String(a) }
  }).join(' ')
}

let installed = false

export function initLogStream() {
  if (installed) return
  installed = true
  const orig = {
    log: console.log.bind(console),
    warn: console.warn.bind(console),
    error: console.error.bind(console)
  }
  console.log = (...args) => { orig.log(...args); pushLine('log', formatArgs(args)) }
  console.warn = (...args) => { orig.warn(...args); pushLine('warn', formatArgs(args)) }
  console.error = (...args) => { orig.error(...args); pushLine('error', formatArgs(args)) }
}

export function isLogStreamEnabled() {
  return process.env.DELMA_LOG_STREAM === '1' || process.env.NODE_ENV !== 'production'
}

export function attachSseClient(res) {
  res.setHeader('Content-Type', 'text/event-stream')
  res.setHeader('Cache-Control', 'no-cache, no-transform')
  res.setHeader('Connection', 'keep-alive')
  res.flushHeaders?.()

  // Replay the ring buffer so the client sees recent history immediately.
  for (const entry of ring) {
    res.write(`data: ${JSON.stringify(entry)}\n\n`)
  }

  clients.add(res)
  const heartbeat = setInterval(() => {
    try { res.write(`: heartbeat\n\n`) } catch { /* noop */ }
  }, 25_000)

  const cleanup = () => {
    clearInterval(heartbeat)
    clients.delete(res)
  }
  res.on('close', cleanup)
  res.on('error', cleanup)
}
