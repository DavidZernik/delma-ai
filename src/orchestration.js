/**
 * orchestration.js — Shared infrastructure for agent coordination.
 *
 * Four primitives:
 *   EventBus     — pub/sub for agent communication
 *   SharedMemory — accumulates during extraction, any agent reads everything
 *   TaskQueue    — dependency-aware parallel execution with semaphore + cascade failure
 *   AgentTools   — scoped tool definitions per agent role
 */

// ── EventBus ─────────────────────────────────────────────────────────────────

export class EventBus {
  constructor() {
    this._subs = {}
    this._history = []
  }

  subscribe(topic, callback) {
    if (!this._subs[topic]) this._subs[topic] = []
    this._subs[topic].push(callback)
    return () => { this._subs[topic] = this._subs[topic].filter(cb => cb !== callback) }
  }

  publish(topic, from, authority, data) {
    const msg = { topic, from, authority, data, timestamp: Date.now() }
    this._history.push(msg)
    console.log(`[bus] ${from}(${authority}) → ${topic}:`, typeof data === 'string' ? data.slice(0, 80) : data)
    for (const cb of this._subs[topic] || []) {
      try { cb(msg) } catch (e) { console.error(`[bus] subscriber error on ${topic}:`, e) }
    }
    for (const cb of this._subs['*'] || []) {
      try { cb(msg) } catch (e) { console.error(`[bus] wildcard error:`, e) }
    }
    return msg
  }

  query({ from, topic } = {}) {
    return this._history.filter(m => (!from || m.from === from) && (!topic || m.topic === topic))
  }

  clear() { this._history = [] }
}

// ── SharedMemory ─────────────────────────────────────────────────────────────

export class SharedMemory {
  constructor() {
    this._store = {}
    this._log = []
  }

  set(key, value, from = 'system') {
    this._store[key] = value
    this._log.push({ key, from, timestamp: Date.now() })
  }

  get(key) { return this._store[key] }
  getAll() { return { ...this._store } }
  getLog() { return [...this._log] }
  clear() { this._store = {}; this._log = [] }

  // Produce a readable markdown digest grouped by who wrote what.
  // Injected into agent prompts so they "see" the full context as structured text.
  getSummary() {
    if (this._log.length === 0) return ''

    const byAgent = {}
    for (const { key, from } of this._log) {
      if (!byAgent[from]) byAgent[from] = []
      const val = this._store[key]
      if (val === undefined || val === null) continue
      const display = typeof val === 'string'
        ? (val.length > 300 ? val.slice(0, 297) + '...' : val)
        : JSON.stringify(val).slice(0, 300)
      byAgent[from].push({ key, display })
    }

    const lines = ['## Shared Context\n']
    for (const [agent, entries] of Object.entries(byAgent)) {
      lines.push(`### ${agent}`)
      for (const { key, display } of entries) {
        lines.push(`- **${key}**: ${display}`)
      }
      lines.push('')
    }
    return lines.join('\n').trimEnd()
  }
}

// ── Semaphore — limits concurrent async operations ───────────────────────────

class Semaphore {
  constructor(max) {
    this._max = max
    this._current = 0
    this._waiting = []
  }

  async acquire() {
    if (this._current < this._max) {
      this._current++
      return
    }
    await new Promise(resolve => this._waiting.push(resolve))
    this._current++
  }

  release() {
    this._current--
    if (this._waiting.length > 0) {
      const next = this._waiting.shift()
      next()
    }
  }

  // Run fn while holding a slot — auto-releases even on error
  async run(fn) {
    await this.acquire()
    try { return await fn() }
    finally { this.release() }
  }
}

// ── TaskQueue ────────────────────────────────────────────────────────────────
//
// Dependency-aware parallel execution with:
//   - Semaphore: limits concurrent tasks (default 2)
//   - Cascade failure: if a task fails, all tasks that depend on it
//     are marked as failed without executing. James won't validate
//     captures that Marcus failed to produce.

export class TaskQueue {
  constructor({ concurrency = 2 } = {}) {
    this._tasks = new Map()
    this._results = new Map()
    this._status = new Map()   // id → 'pending' | 'running' | 'completed' | 'failed'
    this._semaphore = new Semaphore(concurrency)
  }

  add(task) {
    if (!task.id || !task.run) throw new Error('Task must have id and run')
    this._tasks.set(task.id, { ...task, dependsOn: task.dependsOn || [] })
    this._status.set(task.id, 'pending')
  }

  // Recursively cascade-fail all tasks that depend (transitively) on failedId
  _cascadeFail(failedId, pending, finished, onTaskDone) {
    for (const [id, task] of pending) {
      if (this._status.get(id) !== 'pending') continue
      if (!task.dependsOn.includes(failedId)) continue

      console.warn(`[queue] ${id} cascade-failed — dependency ${failedId} failed`)
      this._status.set(id, 'failed')
      this._results.set(id, { error: `Cascade failure: dependency ${failedId} failed` })
      pending.delete(id)
      finished.add(id)
      if (onTaskDone) onTaskDone(task, this._results.get(id))
      // Recurse — anything depending on THIS task also fails
      this._cascadeFail(id, pending, finished, onTaskDone)
    }
  }

  async run(onTaskStart, onTaskDone) {
    const pending = new Map(this._tasks)
    const finished = new Set()

    return new Promise((resolve, reject) => {
      const check = () => {
        for (const [id, task] of pending) {
          if (this._status.get(id) !== 'pending') continue

          // Cascade failure check
          const failedDep = task.dependsOn.find(dep => this._status.get(dep) === 'failed')
          if (failedDep) {
            this._cascadeFail(failedDep, pending, finished, onTaskDone)
            if (finished.size === this._tasks.size) return resolve(Object.fromEntries(this._results))
            check()
            return
          }

          const depsReady = task.dependsOn.every(dep => this._status.get(dep) === 'completed')
          if (!depsReady) continue

          this._status.set(id, 'running')
          pending.delete(id)

          // semaphore.run() auto-releases even on error
          this._semaphore.run(async () => {
            if (onTaskStart) onTaskStart(task)

            const depResults = {}
            for (const dep of task.dependsOn) depResults[dep] = this._results.get(dep)

            try {
              const result = await task.run(depResults)
              this._results.set(id, result)
              this._status.set(id, 'completed')
              finished.add(id)
              if (onTaskDone) onTaskDone(task, result)
              console.log(`[queue] ${id} completed (${finished.size}/${this._tasks.size})`)
            } catch (err) {
              console.error(`[queue] ${id} failed:`, err)
              this._results.set(id, { error: err.message })
              this._status.set(id, 'failed')
              finished.add(id)
              if (onTaskDone) onTaskDone(task, { error: err.message })
            }

            if (finished.size === this._tasks.size) return resolve(Object.fromEntries(this._results))
            check()
          })
        }

        // Deadlock detection
        const stillPending = [...pending.values()].filter(t => this._status.get(t.id) === 'pending')
        if (stillPending.length > 0 && [...this._status.values()].filter(s => s === 'running').length === 0) {
          reject(new Error(`Deadlock: ${stillPending.map(t => t.id).join(', ')}`))
        }
      }

      if (this._tasks.size === 0) return resolve({})
      check()
    })
  }

  getResult(id) { return this._results.get(id) }
  getStatus(id) { return this._status.get(id) }

  clear() {
    this._tasks.clear()
    this._results.clear()
    this._status.clear()
  }
}

// ── AgentTools — scoped tool definitions per agent role ──────────────────────
//
// Each agent gets tools that sharpen their role identity:
//   Sarah: grep (search codebase to challenge claims), file_read (verify context)
//   Marcus: file_read (check actual code when writing logic.md)
//   James: file_read + grep (verify captures against real codebase)
//   Delma: none (she coordinates, doesn't execute)
//
// Tools are async functions that run server-side. The agent's prompt includes
// available tool descriptions; the LLM can request tool calls in its response.
// For now, tools are called during the extraction chain, not via LLM tool_use.
// They're helper functions agents can reference in their prompts.

export class AgentTools {
  constructor(projectDir) {
    this._projectDir = projectDir
    this._scopes = {
      sarah: ['grep', 'file_read'],
      marcus: ['file_read'],
      james: ['file_read', 'grep'],
      delma: []
    }
  }

  // Get tool descriptions for an agent's prompt
  getToolDescriptions(agent) {
    const tools = this._scopes[agent] || []
    if (!tools.length) return ''

    const descs = {
      grep: 'grep(pattern, path?) — search the codebase for a regex pattern. Returns matching lines with file paths.',
      file_read: 'file_read(path) — read a file from the project. Returns the file content.'
    }

    return '\n\nAVAILABLE TOOLS (request in your response if needed):\n' +
      tools.map(t => `- ${descs[t] || t}`).join('\n')
  }

  // Execute a tool call
  async execute(tool, args) {
    if (!this._projectDir) throw new Error('No project directory set')

    if (tool === 'file_read') {
      try {
        const res = await fetch(`/api/tools/file_read`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ path: args.path, projectDir: this._projectDir })
        })
        if (!res.ok) throw new Error(`${res.status}`)
        return (await res.json()).content
      } catch (e) {
        return `Error reading file: ${e.message}`
      }
    }

    if (tool === 'grep') {
      try {
        const res = await fetch(`/api/tools/grep`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ pattern: args.pattern, path: args.path, projectDir: this._projectDir })
        })
        if (!res.ok) throw new Error(`${res.status}`)
        return (await res.json()).matches
      } catch (e) {
        return `Error searching: ${e.message}`
      }
    }

    return `Unknown tool: ${tool}`
  }

  // Get the scope for an agent
  getScope(agent) {
    return this._scopes[agent] || []
  }
}
