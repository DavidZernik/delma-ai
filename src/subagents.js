/**
 * subagents.js — visual sub-agent nodes + parallel API orchestration.
 *
 * Sub-agents are small humanoid figures that appear near their parent
 * agent's position, run focused API calls in parallel, then dissolve
 * when their task is done. Same shape as the main characters, 0.38x scale.
 * Tinted in a lighter version of the parent's color — visibly related,
 * clearly subordinate.
 */

import * as THREE from 'three'
import { CSS2DObject } from 'three/examples/jsm/renderers/CSS2DRenderer.js'
import { callClaudeWithRetry, HAIKU } from './api.js'
import { sleep } from './tickers.js'

// Position offsets [dx, dz] from parent character — toward camera (+z) and spread in X.
const OFFSETS = {
  marcus: [[-1.2, 1.5], [0, 1.8], [1.2, 1.5]],
  james:  [[-1.2, 1.5], [0, 1.8], [1.2, 1.5]],
  sarah:  [[-1.2, 1.5], [0, 1.8], [1.2, 1.5]]
}

// Lighter/desaturated tints of each parent's color — subcontractor uniform
const TINT = {
  marcus: 0x72B890,
  james:  0x8A8A8A,
  sarah:  0xA06070,
  delma:  0x5A8AB0
}

const SCALE      = 0.38   // mini figure scale relative to main characters
const SKIN_COLOR = 0xC8956A
const PANTS_COLOR = 0x222222

// ── Mini humanoid node ─────────────────────────────────────────────────────────

function createNode(scene, parentChar, dx, dz) {
  const px = parentChar.group.position.x
  const pz = parentChar.group.position.z
  const x  = px + dx
  const z  = pz + dz

  const colorKey  = parentChar.def.name.toLowerCase()
  const tintColor = TINT[colorKey] || 0x888888
  const fullColor = parentChar.def.colorInt  // used for completion flash

  // ── Figure group (scaled) ──────────────────────────────────────────────────
  const group = new THREE.Group()
  group.position.set(x, 0, z)
  group.scale.set(SCALE, SCALE, SCALE)
  group.rotation.y = Math.atan2(px - x, pz - z)  // face parent
  scene.add(group)

  // Materials — all transparent, faded in together
  const skinMat  = new THREE.MeshLambertMaterial({ color: SKIN_COLOR,  transparent: true, opacity: 0 })
  const torsoMat = new THREE.MeshLambertMaterial({ color: tintColor,   transparent: true, opacity: 0 })
  const pantsMat = new THREE.MeshLambertMaterial({ color: PANTS_COLOR, transparent: true, opacity: 0 })
  const allMats  = [skinMat, torsoMat, pantsMat]

  // Head
  const head = new THREE.Mesh(new THREE.SphereGeometry(0.145, 10, 8), skinMat)
  head.position.y = 1.58
  group.add(head)

  // Torso
  const torso = new THREE.Mesh(new THREE.BoxGeometry(0.40, 0.54, 0.24), torsoMat)
  torso.position.y = 1.09
  group.add(torso)

  // Arms — simplified single cylinders (no elbow hierarchy, too small to matter)
  const armGeo = new THREE.CylinderGeometry(0.05, 0.04, 0.44, 6)
  const lArm = new THREE.Mesh(armGeo, torsoMat)
  lArm.position.set(-0.24, 1.09, 0)
  lArm.rotation.z = 0.25
  group.add(lArm)
  const rArm = new THREE.Mesh(armGeo, torsoMat)
  rArm.position.set(0.24, 1.09, 0)
  rArm.rotation.z = -0.25
  group.add(rArm)

  // Legs
  const legGeo = new THREE.CylinderGeometry(0.078, 0.072, 0.66, 8)
  const lLeg = new THREE.Mesh(legGeo, pantsMat)
  lLeg.position.set(-0.10, 0.50, 0)
  group.add(lLeg)
  const rLeg = new THREE.Mesh(legGeo, pantsMat)
  rLeg.position.set(0.10, 0.50, 0)
  group.add(rLeg)

  // ── Connection line — added to scene directly so it isn't scaled ──────────
  const lineMat = new THREE.LineBasicMaterial({ color: tintColor, transparent: true, opacity: 0 })
  const lineGeo = new THREE.BufferGeometry().setFromPoints([
    new THREE.Vector3(x,  SCALE * 1.25, z),   // mini mid-torso in world coords
    new THREE.Vector3(px, 1.25,         pz)   // parent mid-torso
  ])
  const line = new THREE.Line(lineGeo, lineMat)
  scene.add(line)
  allMats.push(lineMat)

  // ── Plain text label — no box, floats above head ──────────────────────────
  const labelEl = document.createElement('div')
  labelEl.style.cssText = [
    'font-family:"Courier New",Courier,monospace',
    'font-size:8px',
    'color:#1A1A1A',
    'white-space:nowrap',
    'pointer-events:none',
    'user-select:none',
    'text-align:center',
    'opacity:0',
    'transition:opacity 200ms ease'
  ].join(';')
  const labelObj = new CSS2DObject(labelEl)
  labelObj.position.set(0, 2.2, 0)   // local space; world y ≈ 2.2 * 0.38 ≈ 0.84
  labelObj.visible = false
  group.add(labelObj)

  return {
    labelEl, torsoMat, allMats, group, line, lineGeo,

    async fadeIn() {
      for (let i = 0; i <= 10; i++) {
        const t = i / 10
        for (const m of allMats) m.opacity = t * 0.88
        await sleep(22)
      }
    },

    setLabel(text) {
      labelObj.visible = true
      labelEl.textContent = text
      labelEl.style.opacity = '0.8'
    },

    async complete() {
      // Flash to full parent color to signal done, then revert
      torsoMat.color.setHex(fullColor)
      labelEl.style.opacity = '0'
      labelObj.visible = false
      await sleep(300)
      torsoMat.color.setHex(tintColor)
    },

    async fadeOut() {
      for (let i = 10; i >= 0; i--) {
        const t = i / 10
        for (const m of allMats) m.opacity = t * 0.88
        await sleep(22)
      }
      scene.remove(group)
      scene.remove(line)
      lineGeo.dispose()
      for (const m of allMats) m.dispose()
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
    node.setLabel('failed')
    await sleep(500)
    await node.fadeOut()
    return null
  }
}

/**
 * Run sub-agents in parallel for the given parent character.
 */
export async function runSubAgents(scene, parentChar, defs) {
  const charKey = parentChar.def.name.toLowerCase()
  const offsets = OFFSETS[charKey] || [[0, 1.5]]
  const count   = Math.min(defs.length, offsets.length)

  const nodes = []
  for (let i = 0; i < count; i++) {
    nodes.push(createNode(scene, parentChar, offsets[i][0], offsets[i][1]))
  }

  await Promise.all(nodes.map(n => n.fadeIn()))

  for (let i = 0; i < count; i++) {
    if (defs[i]) nodes[i].setLabel(defs[i].label)
  }

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
        nodes[i].setLabel('failed')
        return null
      }
    })
  )

  await sleep(500)
  await Promise.all(nodes.map(n => n.fadeOut()))

  console.log(`[subagents:${parentChar.def.name}] complete —`, results.filter(Boolean).length, '/', count, 'succeeded')
  return results
}
