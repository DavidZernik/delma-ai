// SSE endpoint that watches a project's CLAUDE.md for external edits.
// When the file changes (the user edits it in their IDE, or Claude Code
// running in the same folder rewrites it), we push a `change` event so
// the Delma UI can refetch and re-render without a manual refresh.
//
// One watcher per HTTP connection. Cleaned up on req.close. fs.watch is
// cheap on macOS/Linux/Windows for a single file, so we don't pool.

import { watch as fsWatch, existsSync } from 'node:fs'
import { join } from 'node:path'
import { safeResolveProjectPath } from '../lib/local-config.js'

export function handleLocalWatch(req, res) {
  let projectDir
  try { projectDir = safeResolveProjectPath(req.query.path) }
  catch (err) { return res.status(400).json({ error: err.message }) }

  const filePath = join(projectDir, 'CLAUDE.md')
  if (!existsSync(filePath)) return res.status(404).json({ error: 'CLAUDE.md not found' })

  res.setHeader('Content-Type', 'text/event-stream')
  res.setHeader('Cache-Control', 'no-cache, no-transform')
  res.setHeader('Connection', 'keep-alive')
  res.flushHeaders?.()
  res.write(`event: ready\ndata: {}\n\n`)

  // Coalesce bursts of events (atomic save = unlink + create + chmod)
  // into a single change event. 150ms is long enough to cover the burst
  // without making "I just saved, refresh" feel laggy.
  let timer = null
  const fire = () => {
    if (timer) return
    timer = setTimeout(() => {
      timer = null
      try { res.write(`event: change\ndata: {"ts":${Date.now()}}\n\n`) }
      catch { /* socket closed mid-write — cleanup will run momentarily */ }
    }, 150)
  }

  let watcher
  try { watcher = fsWatch(filePath, { persistent: false }, fire) }
  catch (err) {
    // fs.watch can throw on some FUSE / network mounts. Fall back to
    // poll-based watching so the feature still works there.
    const interval = setInterval(() => fire(), 2000)
    watcher = { close: () => clearInterval(interval) }
  }

  // Keepalive comment every 25s to defeat proxy idle timeouts.
  const ka = setInterval(() => {
    try { res.write(`: keepalive ${Date.now()}\n\n`) }
    catch { /* ignored, cleanup will follow */ }
  }, 25_000)

  req.on('close', () => {
    clearInterval(ka)
    if (timer) clearTimeout(timer)
    try { watcher.close() } catch { /* idempotent */ }
    try { res.end() } catch { /* idempotent */ }
  })
}
