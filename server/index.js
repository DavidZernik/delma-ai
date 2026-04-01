/**
 * server/index.js — Delma backend.
 *
 * Three responsibilities:
 * 1. WebSocket endpoint that spawns `claude --json` as a child process,
 *    piping stdin/stdout between the browser and the CLI.
 * 2. REST endpoints for .delma/ memory file management (read, write,
 *    compose CLAUDE.md, append session log).
 * 3. Proxy endpoint for LLM API calls (Anthropic, DeepSeek) —
 *    used by the extraction chain.
 */

import express from 'express'
import { config } from 'dotenv'
import { fileURLToPath } from 'url'
import { dirname, join } from 'path'
import { createServer } from 'http'
import { WebSocketServer } from 'ws'
import { spawn } from 'child_process'
import { readdir, readFile, writeFile, mkdir } from 'fs/promises'
import { existsSync } from 'fs'

config()

const __dirname = dirname(fileURLToPath(import.meta.url))

const app = express()
app.use(express.json({ limit: '2mb' }))

// Track active project directory (set by first websocket connection)
let projectDir = null

// ── .delma/ memory file endpoints ────────────────────────────────────────────

async function ensureDelmaDir() {
  if (!projectDir) throw new Error('No project directory set')
  const dir = join(projectDir, '.delma')
  if (!existsSync(dir)) await mkdir(dir, { recursive: true })
  return dir
}

// List all memory files
app.get('/api/memory', async (req, res) => {
  try {
    const dir = await ensureDelmaDir()
    const files = await readdir(dir)
    res.json({ files, projectDir })
  } catch (e) {
    res.status(500).json({ error: e.message })
  }
})

// Sanitize memory filenames — prevent path traversal
function safeMemoryFile(filename) {
  const base = filename.replace(/[^a-zA-Z0-9._-]/g, '')
  if (!base || base.startsWith('.')) return null
  return base
}

// Read a memory file
app.get('/api/memory/:file', async (req, res) => {
  try {
    const safe = safeMemoryFile(req.params.file)
    if (!safe) return res.status(400).json({ error: 'Invalid filename' })
    const dir = await ensureDelmaDir()
    const filePath = join(dir, safe)
    if (!existsSync(filePath)) return res.json({ content: '', exists: false })
    const content = await readFile(filePath, 'utf-8')
    res.json({ content, exists: true })
  } catch (e) {
    res.status(500).json({ error: e.message })
  }
})

// Write a memory file
app.put('/api/memory/:file', async (req, res) => {
  try {
    const safe = safeMemoryFile(req.params.file)
    if (!safe) return res.status(400).json({ error: 'Invalid filename' })
    const dir = await ensureDelmaDir()
    const filePath = join(dir, safe)
    await writeFile(filePath, req.body.content, 'utf-8')
    res.json({ ok: true })
  } catch (e) {
    res.status(500).json({ error: e.message })
  }
})

// Compose CLAUDE.md from all memory files and copy to project root
app.post('/api/memory/compose', async (req, res) => {
  try {
    const dir = await ensureDelmaDir()
    const memoryFiles = ['environment.md', 'logic.md', 'people.md']
    const sections = []

    for (const file of memoryFiles) {
      const filePath = join(dir, file)
      if (existsSync(filePath)) {
        const content = await readFile(filePath, 'utf-8')
        if (content.trim()) sections.push(content.trim())
      }
    }

    const composed = sections.length
      ? `# Composed by Delma — do not edit directly, changes will be overwritten\n\n${sections.join('\n\n---\n\n')}\n`
      : ''

    // Write to .delma/CLAUDE.md (source of truth)
    await writeFile(join(dir, 'CLAUDE.md'), composed, 'utf-8')

    // Copy to project root for Agent SDK to read
    if (composed) {
      await writeFile(join(projectDir, 'CLAUDE.md'), composed, 'utf-8')
    }

    res.json({ ok: true, length: composed.length })
  } catch (e) {
    res.status(500).json({ error: e.message })
  }
})

// Append to session log
app.post('/api/memory/session-log', async (req, res) => {
  try {
    const dir = await ensureDelmaDir()
    const logPath = join(dir, 'session-log.md')
    const existing = existsSync(logPath) ? await readFile(logPath, 'utf-8') : ''
    const entry = `\n## ${new Date().toISOString()}\n${req.body.entry}\n`
    await writeFile(logPath, existing + entry, 'utf-8')
    res.json({ ok: true })
  } catch (e) {
    res.status(500).json({ error: e.message })
  }
})

// ── Existing API endpoints ───────────────────────────────────────────────────

app.post('/api/chat', async (req, res) => {
  const { system, user, max_tokens } = req.body
  const model = req.body.model || 'claude-sonnet-4-20250514'

  // ── DeepSeek (OpenAI-compatible) ─────────────────────────────────────────
  if (model.startsWith('deepseek-')) {
    if (!process.env.DEEPSEEK_API_KEY) {
      return res.status(500).json({ error: 'DEEPSEEK_API_KEY not set in .env' })
    }
    let response
    try {
      response = await fetch('https://api.deepseek.com/v1/chat/completions', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${process.env.DEEPSEEK_API_KEY}`
        },
        body: JSON.stringify({
          model,
          max_tokens: max_tokens ?? 2000,
          messages: [
            ...(system ? [{ role: 'system', content: system }] : []),
            { role: 'user', content: user }
          ]
        })
      })
    } catch (e) {
      return res.status(502).json({ error: 'Failed to reach DeepSeek API: ' + e.message })
    }
    if (!response.ok) {
      const text = await response.text()
      return res.status(response.status).json({ error: `DeepSeek ${response.status}: ${text || '(empty body)'}` })
    }
    const data = await response.json()
    const text = data.choices?.[0]?.message?.content || ''
    return res.json({ content: [{ text }] })
  }

  // ── Anthropic ─────────────────────────────────────────────────────────────
  if (!process.env.ANTHROPIC_API_KEY) {
    return res.status(500).json({ error: 'ANTHROPIC_API_KEY not set in .env' })
  }

  let response
  try {
    response = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': process.env.ANTHROPIC_API_KEY,
        'anthropic-version': '2023-06-01'
      },
      body: JSON.stringify({
        model,
        max_tokens: max_tokens ?? 2000,
        system,
        messages: [{ role: 'user', content: user }]
      })
    })
  } catch (e) {
    return res.status(502).json({ error: 'Failed to reach Anthropic API: ' + e.message })
  }

  if (!response.ok) {
    const text = await response.text()
    return res.status(response.status).json({ error: text })
  }

  const data = await response.json()
  res.json(data)
})

// Serve Vite build in production
if (process.env.NODE_ENV === 'production') {
  const dist = join(__dirname, '../dist')
  app.use(express.static(dist))
  app.get('*', (req, res) => res.sendFile(join(dist, 'index.html')))
}

// ── Start server with WebSocket ──────────────────────────────────────────────

const PORT = process.env.PORT || 3001
const server = createServer(app)

// WebSocket: spawns claude CLI in the user's project directory.
// Client sends { type: 'user_message', content: '...' } — we pipe to stdin.
// Claude's stdout (JSON lines) is parsed and forwarded to the client.
// On disconnect, the claude process is killed.
const wss = new WebSocketServer({ server, path: '/ws/agent-sdk' })

wss.on('connection', async (ws, req) => {
  const url = new URL(req.url, `http://localhost:${PORT}`)
  const dir = url.searchParams.get('dir')

  if (!dir) {
    ws.send(JSON.stringify({ type: 'error', content: 'Missing ?dir= parameter' }))
    ws.close()
    return
  }

  if (!existsSync(dir)) {
    ws.send(JSON.stringify({ type: 'error', content: `Directory does not exist: ${dir}` }))
    ws.close()
    return
  }

  projectDir = dir
  console.log(`[ws] Agent SDK session — project: ${dir}`)

  // Initialize .delma/ with empty memory files if they don't exist
  const delmaDir = join(dir, '.delma')
  if (!existsSync(delmaDir)) {
    await mkdir(delmaDir, { recursive: true })
    console.log(`[ws] created .delma/ directory`)
  }
  const defaultFiles = {
    'environment.md': '# Environment\n\nTech stack, dependencies, infrastructure.\n',
    'logic.md': '# Logic\n\nBusiness logic, patterns, architectural decisions.\n',
    'people.md': '# People\n\nTeam, roles, preferences, org context.\n',
    'session-log.md': '# Session Log\n'
  }
  for (const [file, content] of Object.entries(defaultFiles)) {
    const filePath = join(delmaDir, file)
    if (!existsSync(filePath)) {
      await writeFile(filePath, content, 'utf-8')
      console.log(`[ws] initialized ${file}`)
    }
  }

  // Spawn claude CLI in the project directory
  const claude = spawn('claude', ['--json'], {
    cwd: dir,
    env: { ...process.env, TERM: 'dumb' },
    stdio: ['pipe', 'pipe', 'pipe']
  })

  let stdoutBuf = ''

  claude.stdout.on('data', (data) => {
    stdoutBuf += data.toString()
    // Claude --json outputs one JSON object per line
    const lines = stdoutBuf.split('\n')
    stdoutBuf = lines.pop() // keep incomplete line in buffer
    for (const line of lines) {
      if (!line.trim()) continue
      try {
        const parsed = JSON.parse(line)
        ws.send(JSON.stringify(parsed))
      } catch {
        // Not JSON — send as raw text
        ws.send(JSON.stringify({ type: 'raw', content: line }))
      }
    }
  })

  claude.on('error', (err) => {
    console.error(`[ws] failed to spawn claude:`, err.message)
    ws.send(JSON.stringify({ type: 'error', content: `Failed to start claude: ${err.message}. Is claude CLI installed?` }))
    ws.close()
  })

  claude.stderr.on('data', (data) => {
    const text = data.toString()
    console.error(`[claude stderr] ${text}`)
    ws.send(JSON.stringify({ type: 'error', content: text }))
  })

  claude.on('close', (code) => {
    console.log(`[ws] claude process exited with code ${code}`)
    if (ws.readyState === ws.OPEN) {
      ws.send(JSON.stringify({ type: 'exit', code }))
      ws.close()
    }
  })

  ws.on('message', (msg) => {
    const text = msg.toString()
    try {
      const parsed = JSON.parse(text)
      if (parsed.type === 'user_message') {
        claude.stdin.write(parsed.content + '\n')
      }
    } catch {
      // Raw text — send directly to claude stdin
      claude.stdin.write(text + '\n')
    }
  })

  ws.on('close', () => {
    console.log('[ws] client disconnected')
    claude.kill()
  })
})

server.listen(PORT, () => console.log(`Server on http://localhost:${PORT}`))
