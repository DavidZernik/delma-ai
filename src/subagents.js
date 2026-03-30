/**
 * subagents.js — visual sub-agent nodes + parallel API orchestration.
 *
 * Sub-agents are small floating spheres that appear near their parent
 * agent's position, run focused Haiku calls in parallel, then dissolve
 * when their task is done.
 *
 * Usage:
 *   const results = await runSubAgents(scene, parentChar, [
 *     { label: 'subject name', systemPrompt: P.MARCUS_SUBAGENT, userMessage: {...} },
 *     ...
 *   ])
 *   // results[i] is the parsed JSON from sub-agent i (or null on failure)
 */

import * as THREE from 'three'
import { CSS2DObject } from 'three/examples/jsm/renderers/CSS2DRenderer.js'
import { callClaudeWithRetry, HAIKU } from './api.js'
import { sleep } from './tickers.js'

// Position offsets [dx, dz] from parent character — toward camera (+z) and spread in X.
// Three offsets for Marcus (3 subjects), two for James (factual + methodology).
const OFFSETS = {
  marcus: [[-1.2, 1.5], [0, 1.8], [1.2, 1.5]],
  james:  [[-1.2, 1.5], [0, 1.8], [1.2, 1.5]],
  sarah:  [[-1.2, 1.5], [0, 1.8], [1.2, 1.5]]
}

// Lighter tints of each character's primary color
const TINT = {
  marcus: 0x72B890,
  james:  0x8A8A8A,
  sarah:  0xA06070,
  delma:  0x5A8AB0
}

// ── Single sub-agent node ──────────────────────────────────────────────────────

function createNode(scene, parentChar, dx, dz) {
  const px = parentChar.group.position.x
  const pz = parentChar.group.position.z
  const x = px + dx
  const z = pz + dz

  const colorKey = parentChar.def.name.toLowerCase()
  const color = TINT[colorKey] || 0x888888
  const colorHex = '#' + color.toString(16).padStart(6, '0')

  const group = new THREE.Group()
  group.position.set(x, 0, z)
  scene.add(group)

  // Sphere
  const sphereMat = new THREE.MeshLambertMaterial({
    color,
    emissive: color,
    emissiveIntensity: 0.45,
    transparent: true,
    opacity: 0
  })
  const sphere = new THREE.Mesh(new THREE.SphereGeometry(0.072, 9, 7), sphereMat)
  sphere.position.y = 1.25
  group.add(sphere)

  // Thin connection line (in group-local space: sphere → parent position)
  const linePoints = [
    new THREE.Vector3(0,       1.25, 0),
    new THREE.Vector3(px - x,  1.25, pz - z)
  ]
  const lineMat = new THREE.LineBasicMaterial({ color, transparent: true, opacity: 0 })
  const lineGeo = new THREE.BufferGeometry().setFromPoints(linePoints)
  const line = new THREE.Line(lineGeo, lineMat)
  group.add(line)

  // CSS2D sub-ticker (smaller than main tickers)
  const tickerEl = document.createElement('div')
  tickerEl.className = 'ticker'
  tickerEl.style.borderLeftColor = colorHex
  tickerEl.style.opacity = '0'
  tickerEl.style.fontSize = '9px'
  tickerEl.style.maxWidth = '130px'
  tickerEl.style.lineHeight = '1.3'
  tickerEl.style.padding = '4px 8px'
  const tickerObj = new CSS2DObject(tickerEl)
  tickerObj.position.set(0, 1.68, 0)
  tickerObj.visible = false
  group.add(tickerObj)

  return {
    tickerEl,
    sphereMat,
    lineMat,
    group,

    async fadeIn() {
      for (let i = 0; i <= 10; i++) {
        const t = i / 10
        sphereMat.opacity = t * 0.88
        lineMat.opacity   = t * 0.32
        await sleep(22)
      }
    },

    setLabel(html) {
      tickerObj.visible = true
      tickerEl.innerHTML = html
      tickerEl.style.opacity = '0.92'
    },

    async complete() {
      // Brief emissive flash to signal completion
      sphereMat.emissiveIntensity = 1.0
      tickerEl.style.opacity = '0'
      tickerObj.visible = false
      await sleep(280)
      sphereMat.emissiveIntensity = 0.45
    },

    async fadeOut() {
      for (let i = 10; i >= 0; i--) {
        const t = i / 10
        sphereMat.opacity = t * 0.88
        lineMat.opacity   = t * 0.32
        await sleep(22)
      }
      scene.remove(group)
      // Dispose geometries to avoid leaks
      lineGeo.dispose()
      sphereMat.dispose()
      lineMat.dispose()
    }
  }
}

// ── Public API ────────────────────────────────────────────────────────────────

/**
 * Run a single sub-agent node for one API call.
 * Used by the section pipeline — each section gets its own node per character.
 */
export async function runSingleNode(scene, parentChar, offsetIdx, def) {
  const charKey = parentChar.def.name.toLowerCase()
  const offsets = OFFSETS[charKey] || [[0, 1.5]]
  const [dx, dz] = offsets[offsetIdx % offsets.length]

  const node = createNode(scene, parentChar, dx, dz)
  await node.fadeIn()
  node.setLabel(def.label)

  console.log(`  [node:${parentChar.def.name}:${offsetIdx}] start — ${def.label}`)
  try {
    const result = await callClaudeWithRetry(
      def.systemPrompt,
      def.userMessage,
      () => { node.setLabel(`${def.label} (retrying...)`) },
      def.model || HAIKU,
      def.maxTokens
    )
    console.log(`  [node:${parentChar.def.name}:${offsetIdx}] done`)
    await node.complete()
    await node.fadeOut()
    return result
  } catch (err) {
    console.warn(`  [node:${parentChar.def.name}:${offsetIdx}] failed:`, err.message)
    node.setLabel('⚠ failed')
    await sleep(500)
    await node.fadeOut()
    return null
  }
}

/**
 * Run sub-agents in parallel for the given parent character.
 * @param {THREE.Scene} scene
 * @param {object}      parentChar - character object from characters.js
 * @param {Array}       defs       - [{ label, systemPrompt, userMessage }, ...]
 * @returns {Array}     parsed JSON results (null for each failed sub-agent)
 */
export async function runSubAgents(scene, parentChar, defs) {
  const charKey  = parentChar.def.name.toLowerCase()
  const offsets  = OFFSETS[charKey] || [[0, 1.5]]
  const count    = Math.min(defs.length, offsets.length)

  // Create nodes
  const nodes = []
  for (let i = 0; i < count; i++) {
    nodes.push(createNode(scene, parentChar, offsets[i][0], offsets[i][1]))
  }

  // Fade all in together
  await Promise.all(nodes.map(n => n.fadeIn()))

  // Set labels
  for (let i = 0; i < count; i++) {
    if (defs[i]) nodes[i].setLabel(defs[i].label)
  }

  // Run all API calls in parallel
  console.log(`[subagents:${parentChar.def.name}] spawning ${count} sub-agents`)

  const results = await Promise.all(
    defs.slice(0, count).map(async (def, i) => {
      console.log(`  [subagent:${parentChar.def.name}:${i + 1}] start — ${def.label}`)
      try {
        const result = await callClaudeWithRetry(
          def.systemPrompt,
          def.userMessage,
          () => {
            nodes[i].setLabel(`${def.label} (retrying...)`)
            console.warn(`  [subagent:${parentChar.def.name}:${i + 1}] retrying`)
          },
          HAIKU,
          def.maxTokens
        )
        console.log(`  [subagent:${parentChar.def.name}:${i + 1}] done`, result)
        await nodes[i].complete()
        return result
      } catch (err) {
        console.warn(`  [subagent:${parentChar.def.name}:${i + 1}] failed:`, err.message)
        nodes[i].setLabel('⚠ failed')
        return null
      }
    })
  )

  // Brief pause so completed flash is visible, then fade out
  await sleep(500)
  await Promise.all(nodes.map(n => n.fadeOut()))

  console.log(`[subagents:${parentChar.def.name}] complete —`, results.filter(Boolean).length, '/', count, 'succeeded')
  return results
}
