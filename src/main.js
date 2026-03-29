import { initScene, LEFT_FRAC } from './scene.js'
import { createCharacters } from './characters.js'
import { initChain, runChain } from './chain.js'
import { runComparison } from './comparison.js'

// ── Bootstrap ─────────────────────────────────────────────────────────────
const { scene, camera, renderer, css2dRenderer, clock } = initScene()
const characters = createCharacters(scene)
initChain(scene)

// Size the left panel to match the canvas
const leftEl = document.getElementById('left')
leftEl.style.width = Math.round(window.innerWidth * LEFT_FRAC) + 'px'

// ── DOM refs ──────────────────────────────────────────────────────────────
const input       = document.getElementById('input')
const sendBtn     = document.getElementById('send-btn')
const suggestion  = document.getElementById('suggestion')
const summary     = document.getElementById('summary')
const delmaStatus = document.getElementById('delma-status')
const delmaBody   = document.getElementById('delma-body')
const delmaTime   = document.getElementById('delma-time')

let isRunning = false
let checkpointResolve = null

// ── Checkpoint handler ────────────────────────────────────────────────────
function makeCheckpointHandler() {
  return (framing) => new Promise(resolve => {
    checkpointResolve = resolve
    input.disabled = false
    input.value = ''
    input.placeholder = 'Press Enter to confirm, or type a correction...'
    sendBtn.disabled = false
    suggestion.textContent = `Sarah's framing: "${framing}"`
    suggestion.style.opacity = '1'
    suggestion.style.pointerEvents = 'none'
    input.focus()
  })
}

// ── Submit ────────────────────────────────────────────────────────────────
async function handleSubmit() {
  if (checkpointResolve) {
    const userInput = input.value.trim()
    const resolve = checkpointResolve
    checkpointResolve = null
    input.disabled = true
    input.placeholder = 'Working on it...'
    sendBtn.disabled = true
    suggestion.style.opacity = '0'
    suggestion.textContent = ''
    resolve(userInput || null)
    return
  }

  const query = input.value.trim()
  if (!query || isRunning) return

  clearTimeout(suggestionTimer)
  suggestion.style.opacity = '0'
  suggestion.style.pointerEvents = 'none'
  summary.style.opacity = '0'

  // Reset delma panel
  delmaStatus.textContent = 'Working...'
  delmaBody.textContent = ''
  delmaTime.textContent = ''

  isRunning = true
  input.disabled = true
  input.placeholder = 'Working on it...'
  sendBtn.disabled = true

  const t0 = Date.now()

  // Fire both in parallel
  const compPromise = runComparison(query)

  try {
    const result = await runChain(query, characters, {
      onCheckpoint: makeCheckpointHandler()
    })

    if (result.finalContent) renderDeliverable(result.finalContent)
    renderLog(result.steps, result.duration)

    const elapsed = ((Date.now() - t0) / 1000).toFixed(1)
    delmaStatus.innerHTML = '<span class="comp-done">&#10003;</span> Complete'
    delmaTime.textContent = `${elapsed}s · ${result.steps.length} steps`

    await new Promise(r => setTimeout(r, 2000))
    summary.textContent =
      `${result.steps.length} steps · ${result.corrections} corrections · ${result.improvements} improvements · ${result.duration}s`
    summary.style.opacity = '1'

  } catch (err) {
    console.error('Chain failed:', err)
    delmaStatus.textContent = 'Error'
    const { delma } = characters
    delma.faceCamera()
    delma.tickerEl.innerHTML = 'Having trouble completing this task. Please try again.'
    delma.tickerEl.style.transition = 'opacity 400ms ease'
    delma.tickerEl.style.opacity = '1'
    setTimeout(() => { delma.tickerEl.style.opacity = '0' }, 4000)
  }

  isRunning = false
  input.disabled = false
  input.placeholder = 'Ask a follow-up...'
  input.value = ''
  sendBtn.disabled = false
  input.focus()

  await compPromise
}

// ── Delma panel renderers ─────────────────────────────────────────────────
function renderDeliverable(content) {
  delmaBody.textContent = content
  delmaBody.scrollTop = 0
}

function renderLog(steps, totalSeconds) {
  const divider = '\n\n' + '─'.repeat(36) + '\n  Chain Log\n' + '─'.repeat(36) + '\n\n'
  let log = divider
  for (const s of steps) {
    log += `Step ${s.step}  ${s.from} → ${s.to}  (${s.time})\n`
    log += `${s.summary}\n\n`
  }
  log += `Total: ${totalSeconds}s across ${steps.length} steps`
  delmaBody.textContent += log
  delmaBody.scrollTop = delmaBody.scrollHeight
}

sendBtn.addEventListener('click', handleSubmit)
input.addEventListener('keydown', e => { if (e.key === 'Enter') handleSubmit() })

// ── Auto-suggestion ───────────────────────────────────────────────────────
let suggestionTimer = setTimeout(() => {
  if (!isRunning && !input.value.trim()) {
    suggestion.style.opacity = '1'
    suggestion.style.pointerEvents = 'auto'
  }
}, 6000)

suggestion.addEventListener('click', () => {
  input.value = 'Compare email marketing platforms for a mid-size e-commerce brand'
  suggestion.style.opacity = '0'
  suggestion.style.pointerEvents = 'none'
  handleSubmit()
})

// ── Animation loop ────────────────────────────────────────────────────────
function animate() {
  requestAnimationFrame(animate)
  const elapsed = clock.getElapsedTime()
  for (const char of Object.values(characters)) char.update(elapsed)
  renderer.render(scene, camera)
  css2dRenderer.render(scene, camera)
}

animate()
input.focus()

// ── Resize ────────────────────────────────────────────────────────────────
window.addEventListener('resize', () => {
  const w = Math.round(window.innerWidth * LEFT_FRAC)
  const h = window.innerHeight
  leftEl.style.width = w + 'px'
  camera.aspect = w / h
  camera.updateProjectionMatrix()
  renderer.setSize(w, h)
  css2dRenderer.setSize(w, h)
})
