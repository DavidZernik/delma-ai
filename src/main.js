/**
 * main.js — Application entry point.
 *
 * Wires together:
 * - 3D office scene (left panel) — characters, animations, handoffs
 * - Agent SDK panel (center) — websocket to claude CLI, streaming messages
 * - Comparison panel (right) — vanilla Claude without memory context
 * - Extraction pipeline — watcher scores transcript batches, triggers
 *   the knowledge extraction chain when something worth capturing appears
 *
 * Flow: user types in input → message goes to Agent SDK → response streams
 * back → transcript accumulates → watcher scores → if knowledge found →
 * extraction chain fires → .delma/ files update → CLAUDE.md recomposes
 */

import { initScene, LEFT_FRAC } from './scene.js'
import { createCharacters } from './characters.js'
import { initChain, watchTranscript, runExtraction } from './chain.js'
import { createAgentSDK } from './agent-sdk.js'

// ── Bootstrap ─────────────────────────────────────────────────────────────
const { scene, camera, renderer, css2dRenderer, clock, lightsController, screens } = initScene()
const characters = createCharacters(scene, lightsController, screens)
initChain(scene)

// Size the left panel to match the canvas
const leftEl = document.getElementById('left')
leftEl.style.width = Math.round(window.innerWidth * LEFT_FRAC) + 'px'

// ── DOM refs ──────────────────────────────────────────────────────────────
const input          = document.getElementById('input')
const sendBtn        = document.getElementById('send-btn')
const suggestion     = document.getElementById('suggestion')
const sdkStatus      = document.getElementById('sdk-status')
const sdkBody        = document.getElementById('sdk-body')
const projectDirInput = document.getElementById('project-dir')
const connectBtn     = document.getElementById('connect-btn')

let isExtracting = false

// ── Agent SDK client ─────────────────────────────────────────────────────
const agentSDK = createAgentSDK({
  onMessage: handleSDKMessage,
  onStatus: handleSDKStatus,
  onTranscriptBatch: handleTranscriptBatch
})

function handleSDKMessage(data) {
  // Skip user_message echoes from server — we render those locally in handleSubmit
  if (data.type === 'user_message') return
  renderSDKMessage(data)
}

function renderSDKMessage(data) {
  const el = document.createElement('div')
  el.className = `sdk-message sdk-${data.type || 'raw'}`

  if (data.type === 'user_message') {
    el.className = 'sdk-message sdk-user'
    el.textContent = data.content
  } else if (data.type === 'assistant' || data.type === 'assistant_message') {
    el.className = 'sdk-message sdk-assistant'
    el.textContent = data.content || JSON.stringify(data)
  } else if (data.type === 'tool_use') {
    el.className = 'sdk-message sdk-tool'
    el.textContent = `⚡ ${data.name || data.tool}: ${JSON.stringify(data.input || '').slice(0, 100)}...`
  } else if (data.type === 'tool_result') {
    el.className = 'sdk-message sdk-tool-result'
    el.textContent = JSON.stringify(data.content || data.output || '').slice(0, 200)
  } else if (data.type === 'error') {
    el.className = 'sdk-message sdk-error'
    el.textContent = `Error: ${data.content}`
  } else if (data.type === 'exit') {
    el.className = 'sdk-message sdk-status'
    el.textContent = `Session ended (code ${data.code})`
  } else {
    el.textContent = JSON.stringify(data).slice(0, 300)
  }

  sdkBody.appendChild(el)
  sdkBody.scrollTop = sdkBody.scrollHeight
}

function handleSDKStatus(status) {
  const labels = {
    connecting: 'Connecting...',
    connected: 'Connected',
    disconnected: 'Disconnected',
    error: 'Connection error'
  }
  sdkStatus.textContent = labels[status] || status

  if (status === 'connected') {
    input.disabled = false
    input.placeholder = 'Ask Claude...'
    sendBtn.disabled = false
    connectBtn.textContent = 'Disconnect'
  } else if (status === 'disconnected') {
    input.disabled = false
    input.placeholder = 'Connect to start...'
    connectBtn.textContent = 'Connect'
  }
}

// Called by agent-sdk.js every BATCH_SIZE messages.
// Two-phase: watcher scores first (cheap Haiku call), then full extraction if worthwhile.
async function handleTranscriptBatch(batch) {
  if (isExtracting) return // don't overlap extraction chains
  if (!batch.trim()) return

  console.log('[main] transcript batch ready:', batch.length, 'chars')

  // Step 1: Watcher scores the batch
  const watchResult = await watchTranscript(batch, characters)

  if (watchResult.score < 0.3) {
    console.log('[main] watcher: noise, skipping')
    return
  }

  // Step 2: Load existing memory
  const existingMemory = await loadMemory()

  // Step 3: Run full extraction chain
  isExtracting = true
  try {
    const result = await runExtraction(batch, existingMemory, characters)
    console.log('[main] extraction complete:', result.updates.length, 'files updated')
  } catch (err) {
    console.error('[main] extraction failed:', err)
  }
  isExtracting = false
}

async function loadMemory() {
  const files = ['environment.md', 'logic.md', 'people.md']
  const memory = {}
  for (const file of files) {
    try {
      const res = await fetch(`/api/memory/${file}`)
      const data = await res.json()
      memory[file] = data.content || ''
    } catch {
      memory[file] = ''
    }
  }
  return memory
}

// ── Connect/Disconnect ───────────────────────────────────────────────────
connectBtn.addEventListener('click', () => {
  if (agentSDK.isConnected()) {
    agentSDK.disconnect()
  } else {
    const dir = projectDirInput.value.trim()
    if (!dir) {
      projectDirInput.focus()
      return
    }
    agentSDK.connect(dir)
  }
})

// ── Submit to Agent SDK ──────────────────────────────────────────────────
async function handleSubmit() {
  const query = input.value.trim()
  if (!query) return

  input.value = ''
  input.style.height = 'auto'

  if (!agentSDK.isConnected()) {
    // If not connected, just show a message
    const el = document.createElement('div')
    el.className = 'sdk-message sdk-error'
    el.textContent = 'Not connected. Set project directory and click Connect.'
    sdkBody.appendChild(el)
    return
  }

  // Render user message immediately (don't wait for server echo)
  renderSDKMessage({ type: 'user_message', content: query })

  // Send to Agent SDK
  agentSDK.send(query)
}

// ── Event listeners ──────────────────────────────────────────────────────
sendBtn.addEventListener('click', handleSubmit)
input.addEventListener('keydown', e => {
  if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); handleSubmit() }
})
input.addEventListener('input', () => {
  input.style.height = 'auto'
  input.style.height = Math.min(input.scrollHeight, 120) + 'px'
})

// ── Auto-suggestion ──────────────────────────────────────────────────────
setTimeout(() => {
  if (!agentSDK.isConnected() && !input.value.trim()) {
    suggestion.style.opacity = '1'
    suggestion.style.pointerEvents = 'auto'
  }
}, 6000)

// ── Animation loop ────────────────────────────────────────────────────────
function animate() {
  requestAnimationFrame(animate)
  const elapsed = clock.getElapsedTime()
  for (const char of Object.values(characters)) char.update(elapsed)
  lightsController.tick()
  renderer.render(scene, camera)
  css2dRenderer.render(scene, camera)
}

animate()
input.focus()

// ── Resize — handles desktop (side-by-side) and mobile (stacked) ─────────
function handleResize() {
  const isMobile = window.innerWidth <= 768
  let w, h

  if (isMobile) {
    w = window.innerWidth
    h = leftEl.clientHeight
    leftEl.style.width = ''  // let CSS handle it
  } else {
    w = Math.round(window.innerWidth * LEFT_FRAC)
    h = window.innerHeight
    leftEl.style.width = w + 'px'
  }

  camera.aspect = w / h
  camera.updateProjectionMatrix()
  renderer.setSize(w, h)
  css2dRenderer.setSize(w, h)
}

window.addEventListener('resize', handleResize)
handleResize()  // run once on load to handle initial mobile state
