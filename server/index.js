import express from 'express'
import { config } from 'dotenv'
import { fileURLToPath } from 'url'
import { dirname, join, relative, resolve } from 'path'
import { createServer } from 'http'
import { WebSocketServer } from 'ws'
import { spawn } from 'child_process'
import { readFile, writeFile } from 'fs/promises'
import { existsSync } from 'fs'
import {
  ensureProjectState,
  readWorkspace,
  readGraph,
  readMemoryMap,
  listHistory,
  writeWorkspace,
  composeClaudeMd,
  safeMemoryFile,
  getDelmaPath,
  getHistoryDir,
  defaultWorkspace
} from './delma-state.js'

config()

const __dirname = dirname(fileURLToPath(import.meta.url))
const app = express()
const PORT = process.env.PORT || 3001

app.use(express.json({ limit: '4mb' }))

let projectDir = null

app.get('/api/health', async (req, res) => {
  res.json({ ok: true, projectDir })
})

app.post('/api/project/open', async (req, res) => {
  try {
    const dir = resolve(req.body.projectDir || '')
    if (!existsSync(dir)) {
      return res.status(400).json({ error: `Directory does not exist: ${dir}` })
    }
    projectDir = dir
    await ensureProjectState(projectDir)
    await composeClaudeMd(projectDir)
    res.json({ ok: true, projectDir })
  } catch (e) {
    res.status(500).json({ error: e.message })
  }
})

app.get('/api/memory', async (req, res) => {
  try {
    await ensureProjectState()
    const files = await readdir(getDelmaPath(projectDir))
    res.json({ files, projectDir })
  } catch (e) {
    res.status(500).json({ error: e.message })
  }
})

app.get('/api/memory/:file', async (req, res) => {
  try {
    const safe = safeMemoryFile(req.params.file)
    if (!safe) return res.status(400).json({ error: 'Invalid filename' })
    await ensureProjectState()
    const filePath = join(getDelmaPath(projectDir), safe)
    if (!existsSync(filePath)) return res.json({ content: '', exists: false })
    const content = await readFile(filePath, 'utf-8')
    res.json({ content, exists: true })
  } catch (e) {
    res.status(500).json({ error: e.message })
  }
})

app.put('/api/memory/:file', async (req, res) => {
  try {
    const safe = safeMemoryFile(req.params.file)
    if (!safe) return res.status(400).json({ error: 'Invalid filename' })
    await ensureProjectState()
    const filePath = join(getDelmaPath(projectDir), safe)
    await writeFile(filePath, req.body.content ?? '', 'utf-8')
    await composeClaudeMd(projectDir)
    res.json({ ok: true })
  } catch (e) {
    res.status(500).json({ error: e.message })
  }
})

app.post('/api/memory/compose', async (req, res) => {
  try {
    const composed = await composeClaudeMd(projectDir)
    res.json({ ok: true, length: composed.length })
  } catch (e) {
    res.status(500).json({ error: e.message })
  }
})

app.post('/api/memory/session-log', async (req, res) => {
  try {
    await ensureProjectState()
    const filePath = join(getDelmaPath(projectDir), 'session-log.md')
    const existing = existsSync(filePath) ? await readFile(filePath, 'utf-8') : '# Session Log\n'
    const entry = `\n## ${new Date().toISOString()}\n${req.body.entry ?? ''}\n`
    await writeFile(filePath, existing + entry, 'utf-8')
    res.json({ ok: true })
  } catch (e) {
    res.status(500).json({ error: e.message })
  }
})

app.get('/api/delma/state', async (req, res) => {
  try {
    await ensureProjectState()
    const [workspace, graph, memory, history] = await Promise.all([
      readWorkspace(),
      readGraph(),
      readMemoryMap(),
      listHistory()
    ])
    res.json({
      projectDir,
      workspace,
      graph,
      memory,
      history: history.slice(0, 30)
    })
  } catch (e) {
    res.status(500).json({ error: e.message })
  }
})

app.put('/api/delma/workspace', async (req, res) => {
  try {
    await ensureProjectState()
    const result = await writeWorkspace(projectDir, req.body.workspace ?? defaultWorkspace(projectDir), req.body.reason ?? 'workspace-save')
    res.json({ ok: true, ...result })
  } catch (e) {
    res.status(500).json({ error: e.message })
  }
})

app.get('/api/delma/history', async (req, res) => {
  try {
    await ensureProjectState()
    const history = await listHistory()
    res.json({ files: history })
  } catch (e) {
    res.status(500).json({ error: e.message })
  }
})

app.get('/api/delma/history/:file', async (req, res) => {
  try {
    await ensureProjectState()
    const safe = safeMemoryFile(req.params.file)
    if (!safe) return res.status(400).json({ error: 'Invalid filename' })
    const filePath = join(getHistoryDir(projectDir), safe)
    if (!existsSync(filePath)) return res.status(404).json({ error: 'Snapshot not found' })
    const content = JSON.parse(await readFile(filePath, 'utf-8'))
    res.json(content)
  } catch (e) {
    res.status(500).json({ error: e.message })
  }
})

app.post('/api/tools/file_read', async (req, res) => {
  try {
    const { path: filePath, projectDir: dir } = req.body
    if (!dir || !filePath) return res.status(400).json({ error: 'Missing path or projectDir' })

    const resolvedDir = resolve(dir)
    const resolvedPath = resolve(dir, filePath)
    if (!resolvedPath.startsWith(resolvedDir)) return res.status(403).json({ error: 'Path traversal rejected' })
    if (!existsSync(resolvedPath)) return res.json({ content: '', exists: false })

    const content = await readFile(resolvedPath, 'utf-8')
    res.json({
      content: content.slice(0, 10240),
      exists: true,
      truncated: content.length > 10240
    })
  } catch (e) {
    res.status(500).json({ error: e.message })
  }
})

app.post('/api/tools/grep', async (req, res) => {
  try {
    const { pattern, path: subPath, projectDir: dir } = req.body
    if (!dir || !pattern) return res.status(400).json({ error: 'Missing pattern or projectDir' })

    const { execSync } = await import('child_process')
    const searchDir = subPath ? join(dir, subPath) : dir
    if (!searchDir.startsWith(dir)) return res.status(403).json({ error: 'Path traversal rejected' })

    try {
      const cmd = `grep -rn --include='*.{js,ts,json,md,py,jsx,tsx}' -m 50 '${pattern.replace(/'/g, "\\'")}' '${searchDir}' 2>/dev/null | head -50`
      const output = execSync(cmd, { timeout: 5000, maxBuffer: 1024 * 64 }).toString()
      const matches = output.split('\n').filter(Boolean).map((line) => {
        const match = line.match(/^(.+?):(\d+):(.*)$/)
        if (!match) return { line }
        return {
          file: relative(dir, match[1]),
          lineNum: parseInt(match[2], 10),
          content: match[3].trim()
        }
      })
      res.json({ matches })
    } catch (e) {
      if (e.status === 1) return res.json({ matches: [] })
      throw e
    }
  } catch (e) {
    res.status(500).json({ error: e.message })
  }
})

async function callOpenAICompatible(apiUrl, apiKey, provider, model, system, user, max_tokens, res) {
  let response
  try {
    response = await fetch(apiUrl, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${apiKey}`
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
    return res.status(502).json({ error: `Failed to reach ${provider} API: ${e.message}` })
  }

  if (!response.ok) {
    const text = await response.text()
    return res.status(response.status).json({ error: `${provider} ${response.status}: ${text || '(empty body)'}` })
  }

  const data = await response.json()
  const text = data.choices?.[0]?.message?.content || ''
  return res.json({ content: [{ text }] })
}

app.post('/api/chat', async (req, res) => {
  const { system, user, max_tokens } = req.body
  const model = req.body.model || 'claude-sonnet-4-20250514'

  if (model.startsWith('deepseek-')) {
    if (!process.env.DEEPSEEK_API_KEY) return res.status(500).json({ error: 'DEEPSEEK_API_KEY not set in .env' })
    return callOpenAICompatible('https://api.deepseek.com/v1/chat/completions', process.env.DEEPSEEK_API_KEY, 'DeepSeek', model, system, user, max_tokens, res)
  }

  if (model.startsWith('gpt-') || model.startsWith('o1') || model.startsWith('o3')) {
    if (!process.env.OPENAI_API_KEY) return res.status(500).json({ error: 'OPENAI_API_KEY not set in .env' })
    return callOpenAICompatible('https://api.openai.com/v1/chat/completions', process.env.OPENAI_API_KEY, 'OpenAI', model, system, user, max_tokens, res)
  }

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

if (process.env.NODE_ENV === 'production') {
  const dist = join(__dirname, '../dist')
  app.use(express.static(dist))
  app.get('*', (req, res) => res.sendFile(join(dist, 'index.html')))
}

const server = createServer(app)
const wss = new WebSocketServer({ server, path: '/ws/agent-sdk' })

wss.on('connection', async (ws, req) => {
  const url = new URL(req.url, `http://localhost:${PORT}`)
  const dir = url.searchParams.get('dir')

  if (!dir) {
    ws.send(JSON.stringify({ type: 'error', content: 'Missing ?dir= parameter' }))
    ws.close()
    return
  }

  const resolvedDir = resolve(dir)
  if (!existsSync(resolvedDir)) {
    ws.send(JSON.stringify({ type: 'error', content: `Directory does not exist: ${resolvedDir}` }))
    ws.close()
    return
  }

  projectDir = resolvedDir
  await ensureProjectState(projectDir)
  await composeClaudeMd(projectDir)

  const claude = spawn('claude', ['--json'], {
    cwd: resolvedDir,
    env: { ...process.env, TERM: 'dumb' },
    stdio: ['pipe', 'pipe', 'pipe']
  })

  let stdoutBuf = ''

  claude.stdout.on('data', (data) => {
    stdoutBuf += data.toString()
    const lines = stdoutBuf.split('\n')
    stdoutBuf = lines.pop()
    for (const line of lines) {
      if (!line.trim()) continue
      try {
        ws.send(JSON.stringify(JSON.parse(line)))
      } catch {
        ws.send(JSON.stringify({ type: 'raw', content: line }))
      }
    }
  })

  claude.on('error', (err) => {
    ws.send(JSON.stringify({ type: 'error', content: `Failed to start claude: ${err.message}. Is claude CLI installed?` }))
    ws.close()
  })

  claude.stderr.on('data', (data) => {
    ws.send(JSON.stringify({ type: 'error', content: data.toString() }))
  })

  claude.on('close', (code) => {
    if (ws.readyState === ws.OPEN) {
      ws.send(JSON.stringify({ type: 'exit', code }))
      ws.close()
    }
  })

  ws.on('message', async (msg) => {
    const text = msg.toString()
    try {
      const parsed = JSON.parse(text)
      if (parsed.type === 'user_message') {
        claude.stdin.write(parsed.content + '\n')
        const logPath = join(getDelmaPath(projectDir), 'session-log.md')
        const existing = existsSync(logPath) ? await readFile(logPath, 'utf-8') : '# Session Log\n'
        const stamp = new Date().toISOString()
        await writeFile(logPath, `${existing}\n- ${stamp} USER: ${parsed.content}\n`, 'utf-8')
      }
    } catch {
      claude.stdin.write(text + '\n')
    }
  })

  ws.on('close', () => {
    claude.kill()
    if (projectDir === resolvedDir) projectDir = null
  })
})

server.listen(PORT, () => console.log(`Server on http://localhost:${PORT}`))
