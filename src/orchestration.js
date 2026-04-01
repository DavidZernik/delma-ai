/**
 * orchestration.js — Shared infrastructure for agent coordination.
 *
 * Three primitives:
 *   EventBus     — pub/sub for agent communication. Agents publish observations,
 *                  others subscribe to what they care about. Messages carry the
 *                  sender's role and authority — the bus reflects hierarchy.
 *   SharedMemory — accumulates during extraction. Any agent can read everything
 *                  any other agent produced. Structured by role.
 *   TaskQueue    — dependency-aware task execution. Tasks declare what they
 *                  depend on, queue resolves order automatically. Independent
 *                  tasks run in parallel.
 *
 * These are lightweight (~100 lines each), not frameworks. Built for 4 specialist
 * agents today, extensible to conversation mode and user input later.
 */

// ── EventBus ─────────────────────────────────────────────────────────────────
//
// Pub/sub for agents. Each message has:
//   { topic, from, authority, data, timestamp }
//
// Topics are strings: 'extraction', 'challenge', 'rejection', 'correction', etc.
// Agents subscribe to topics they care about. The bus doesn't filter by authority —
// subscribers decide how to weight messages based on who sent them.

export class EventBus {
  constructor() {
    this._subs = {}    // topic → [callback]
    this._history = [] // all messages, for late subscribers or debugging
  }

  subscribe(topic, callback) {
    if (!this._subs[topic]) this._subs[topic] = []
    this._subs[topic].push(callback)
    return () => {
      this._subs[topic] = this._subs[topic].filter(cb => cb !== callback)
    }
  }

  publish(topic, from, authority, data) {
    const msg = { topic, from, authority, data, timestamp: Date.now() }
    this._history.push(msg)
    console.log(`[bus] ${from}(${authority}) → ${topic}:`, typeof data === 'string' ? data.slice(0, 80) : data)
    for (const cb of this._subs[topic] || []) {
      try { cb(msg) } catch (e) { console.error(`[bus] subscriber error on ${topic}:`, e) }
    }
    // Wildcard subscribers get everything
    for (const cb of this._subs['*'] || []) {
      try { cb(msg) } catch (e) { console.error(`[bus] wildcard subscriber error:`, e) }
    }
    return msg
  }

  // Get all messages from a specific sender or topic
  query({ from, topic } = {}) {
    return this._history.filter(m =>
      (!from || m.from === from) && (!topic || m.topic === topic)
    )
  }

  clear() {
    this._history = []
  }
}

// ── SharedMemory ─────────────────────────────────────────────────────────────
//
// Accumulates during extraction. Every agent writes here, every agent can read.
// Entries are tagged with the agent's role — so James can see "Sarah challenged
// this" and "Marcus wrote that" and understand the authority chain.
//
// Not a generic key-value store. Structured for knowledge extraction:
//   - transcript: the raw batch being processed
//   - existing: current .delma/ file contents
//   - extractions: what Sarah identified as worth capturing
//   - rejections: what Sarah decided to skip
//   - updates: what Marcus wrote
//   - validation: James's verdict
//   - corrections: user corrections (future: conversation mode)

export class SharedMemory {
  constructor() {
    this._store = {}
    this._log = []  // ordered list of all writes for audit trail
  }

  // Write a value. Tracks who wrote it and when.
  set(key, value, from = 'system') {
    this._store[key] = value
    this._log.push({ key, from, timestamp: Date.now() })
  }

  get(key) {
    return this._store[key]
  }

  // Get everything — agents see the full picture
  getAll() {
    return { ...this._store }
  }

  // Get the audit trail — who wrote what when
  getLog() {
    return [...this._log]
  }

  clear() {
    this._store = {}
    this._log = []
  }
}

// ── TaskQueue ────────────────────────────────────────────────────────────────
//
// Dependency-aware task execution. Each task declares:
//   { id, agent, run: async fn, dependsOn: [taskId] }
//
// The queue resolves dependencies and runs independent tasks in parallel.
// When all dependencies for a task are complete, it fires.
//
// Example:
//   queue.add({ id: 'sarah', agent: 'sarah', run: runSarah })
//   queue.add({ id: 'marcus-env', agent: 'marcus', run: runMarcusEnv, dependsOn: ['sarah'] })
//   queue.add({ id: 'marcus-people', agent: 'marcus', run: runMarcusPeople, dependsOn: ['sarah'] })
//   queue.add({ id: 'james', agent: 'james', run: runJames, dependsOn: ['marcus-env', 'marcus-people'] })
//   await queue.run()
//   // sarah runs first, then marcus-env and marcus-people in parallel, then james

export class TaskQueue {
  constructor() {
    this._tasks = new Map()  // id → task definition
    this._results = new Map() // id → result
  }

  add(task) {
    if (!task.id || !task.run) throw new Error('Task must have id and run')
    this._tasks.set(task.id, {
      ...task,
      dependsOn: task.dependsOn || []
    })
  }

  async run(onTaskStart, onTaskDone) {
    const pending = new Map(this._tasks)
    const running = new Set()
    const completed = new Set()

    return new Promise((resolve, reject) => {
      const check = () => {
        // Find tasks whose dependencies are all met
        for (const [id, task] of pending) {
          if (running.has(id)) continue
          const depsmet = task.dependsOn.every(dep => completed.has(dep))
          if (!depsmet) continue

          // All deps met — run this task
          running.add(id)
          pending.delete(id)

          if (onTaskStart) onTaskStart(task)

          const depResults = {}
          for (const dep of task.dependsOn) {
            depResults[dep] = this._results.get(dep)
          }

          task.run(depResults)
            .then(result => {
              this._results.set(id, result)
              running.delete(id)
              completed.add(id)
              if (onTaskDone) onTaskDone(task, result)
              console.log(`[queue] ${id} complete (${completed.size}/${this._tasks.size})`)

              if (completed.size === this._tasks.size) {
                resolve(Object.fromEntries(this._results))
              } else {
                check()
              }
            })
            .catch(err => {
              console.error(`[queue] ${id} failed:`, err)
              running.delete(id)
              completed.add(id)
              this._results.set(id, { error: err.message })
              if (onTaskDone) onTaskDone(task, { error: err.message })

              // Continue despite failure — other tasks may not depend on this one
              if (completed.size === this._tasks.size) {
                resolve(Object.fromEntries(this._results))
              } else {
                check()
              }
            })
        }

        // Deadlock detection: nothing running, nothing can start, but tasks remain
        if (running.size === 0 && pending.size > 0) {
          const stuck = [...pending.keys()]
          console.error(`[queue] deadlock — stuck tasks: ${stuck.join(', ')}`)
          reject(new Error(`Deadlock: tasks ${stuck.join(', ')} have unresolvable dependencies`))
        }
      }

      if (this._tasks.size === 0) {
        resolve({})
      } else {
        check()
      }
    })
  }

  getResult(id) {
    return this._results.get(id)
  }

  clear() {
    this._tasks.clear()
    this._results.clear()
  }
}
