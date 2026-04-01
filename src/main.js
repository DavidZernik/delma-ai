import { initScene, LEFT_FRAC } from './scene.js'
import { createCharacters } from './characters.js'
import { initChain, runChain } from './chain.js'
import { runComparison } from './comparison.js'
import { callClaudeRaw } from './api.js'

// ── Bootstrap ─────────────────────────────────────────────────────────────
const { scene, camera, renderer, css2dRenderer, clock, lightsController, screens } = initScene()
const characters = createCharacters(scene, lightsController, screens)
initChain(scene)

// Size the left panel to match the canvas
const leftEl = document.getElementById('left')
leftEl.style.width = Math.round(window.innerWidth * LEFT_FRAC) + 'px'

// ── DOM refs ──────────────────────────────────────────────────────────────
const input       = document.getElementById('input')
const sendBtn     = document.getElementById('send-btn')
const suggestion  = document.getElementById('suggestion')
const summary     = document.getElementById('summary')
const delmaStatus    = document.getElementById('delma-status')
const delmaBody      = document.getElementById('delma-body')
const delmaTime      = document.getElementById('delma-time')
const analysisStatus = document.getElementById('analysis-status')
const analysisBody   = document.getElementById('analysis-body')

let isRunning = false
let currentDelmaResponseEl = null

function appendTurn(query) {
  const turnEl = document.createElement('div')
  turnEl.className = 'turn'

  const userMsgEl = document.createElement('div')
  userMsgEl.className = 'user-msg'
  userMsgEl.textContent = query

  const responseEl = document.createElement('div')
  responseEl.className = 'response-text'

  turnEl.appendChild(userMsgEl)
  turnEl.appendChild(responseEl)
  delmaBody.appendChild(turnEl)
  delmaBody.scrollTop = delmaBody.scrollHeight

  currentDelmaResponseEl = responseEl
  return responseEl
}

// ── Submit ────────────────────────────────────────────────────────────────
async function handleSubmit() {
  const query = input.value.trim()
  if (!query || isRunning) return

  clearTimeout(suggestionTimer)
  suggestion.style.opacity = '0'
  suggestion.style.pointerEvents = 'none'
  summary.style.opacity = '0'

  // Append new turn, reset status
  appendTurn(query)
  delmaStatus.textContent = 'Working...'
  delmaTime.textContent = ''

  // Reset analysis panel
  analysisStatus.textContent = ''
  analysisBody.textContent = ''

  isRunning = true
  input.disabled = true
  input.placeholder = 'Working on it...'
  input.style.height = 'auto'
  sendBtn.disabled = true

  const t0 = Date.now()

  // Fire comparison in parallel (if enabled)
  const compareOn = !document.body.classList.contains('compare-off')
  const compPromise = compareOn ? runComparison(query) : Promise.resolve()

  try {
    const speed = document.getElementById('speed-select').value
    const budget = document.getElementById('budget-select').value
    const result = await runChain(query, characters, {
      onDocument: (content) => renderDeliverable(content),
      speed,
      budget
    })

    // Final render in case onDocument wasn't called or document changed after last call
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
  input.style.height = 'auto'
  sendBtn.disabled = false
  input.focus()

  await compPromise
  if (compareOn) await runAnalysis(query)
}

// ── Delma panel renderers ─────────────────────────────────────────────────
function renderDeliverable(content) {
  if (currentDelmaResponseEl) currentDelmaResponseEl.textContent = content
  delmaBody.scrollTop = delmaBody.scrollHeight
}

function renderLog(steps, totalSeconds) {
  if (!currentDelmaResponseEl) return
  const divider = '\n\n' + '─'.repeat(36) + '\n  Chain Log\n' + '─'.repeat(36) + '\n\n'
  let log = divider
  for (const s of steps) {
    log += `Step ${s.step}  ${s.from} → ${s.to}  (${s.time})\n`
    log += `${s.summary}\n\n`
  }
  log += `Total: ${totalSeconds}s across ${steps.length} steps`
  currentDelmaResponseEl.textContent += log
  delmaBody.scrollTop = delmaBody.scrollHeight
}

async function runAnalysis(query) {
  const claudeBody = document.getElementById('claude-body')
  const lastClaudeResponse = claudeBody.querySelector('.turn:last-child .response-text')
  const claudeText = lastClaudeResponse?.textContent.trim() || ''
  const delmaText  = currentDelmaResponseEl?.textContent.trim() || ''
  if (!claudeText || !delmaText) return

  // Use only the deliverable portion of Delma (before the chain log divider)
  const dividerIdx = delmaText.indexOf('────')
  const delmaDeliverable = dividerIdx > 0 ? delmaText.slice(0, dividerIdx).trim() : delmaText

  analysisStatus.textContent = 'Analyzing...'
  analysisBody.textContent = ''

  const system = `You're analyzing whether a multi-agent team structure produced better output than a single model call. Don't just compare quality — explain WHY the team structure helped or didn't. What specific decision by which agent made the difference? Did the briefing shape the output? Did the team add overhead without value? Be specific: name the agent, the decision, and the effect. 2-3 sentences, plain English, no hedging.`
  const user = `Request: "${query}"\n\nSingle model (one call, no team):\n${claudeText}\n\nDelma team output:\n${delmaDeliverable}`

  try {
    const analysis = await callClaudeRaw(system, user)
    analysisBody.textContent = analysis
  } catch (err) {
    analysisBody.textContent = 'Analysis unavailable.'
  }
  analysisStatus.textContent = ''
}

sendBtn.addEventListener('click', handleSubmit)
input.addEventListener('keydown', e => {
  if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); handleSubmit() }
})
input.addEventListener('input', () => {
  input.style.height = 'auto'
  input.style.height = Math.min(input.scrollHeight, 120) + 'px'
})

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

// ── Compare toggle ───────────────────────────────────────────────────────
const compareToggle = document.getElementById('compare-toggle')
compareToggle.addEventListener('click', () => {
  document.body.classList.toggle('compare-off')
  const on = !document.body.classList.contains('compare-off')
  compareToggle.textContent = `Compare: ${on ? 'ON' : 'OFF'}`
})

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
