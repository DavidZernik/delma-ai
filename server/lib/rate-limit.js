// Tiny in-memory rate limiter. Keeps a rolling window per key (usually
// user id) and rejects calls past the cap. Stateless across restarts —
// good enough for a single-process Express server; if we ever go
// multi-instance, swap for Redis.
//
// Usage:
//   const limit = makeLimiter({ windowMs: 60_000, max: 20 })
//   if (!limit.allow(userId)) return res.status(429).json({ error: 'slow down' })

export function makeLimiter({ windowMs, max }) {
  const buckets = new Map() // key -> { count, windowStart }

  // Periodic sweep so keys that stop calling don't leak forever.
  const sweep = setInterval(() => {
    const now = Date.now()
    for (const [k, b] of buckets) {
      if (now - b.windowStart > windowMs * 2) buckets.delete(k)
    }
  }, Math.max(windowMs, 60_000))
  sweep.unref?.()

  return {
    allow(key) {
      if (!key) return true // no key = can't track; let through
      const now = Date.now()
      const b = buckets.get(key)
      if (!b || now - b.windowStart > windowMs) {
        buckets.set(key, { count: 1, windowStart: now })
        return true
      }
      if (b.count >= max) return false
      b.count++
      return true
    },
    // For diagnostics / tests.
    _size: () => buckets.size
  }
}
