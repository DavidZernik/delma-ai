import * as THREE from 'three'
import { CSS2DObject } from 'three/examples/jsm/renderers/CSS2DRenderer.js'

const _identityQ = new THREE.Quaternion()

// ── Character definitions ─────────────────────────────────────────────────
// deskRotY:   rotation when seated at desk (faces -Z = into room)
// cameraRotY: rotation when facing side camera at X=-4
const DEFS = {
  delma: {
    name: 'Delma', role: 'Coordinator',
    colorHex: '#1B3A5C', colorInt: 0x1B3A5C,
    skinInt: 0xD4956A,   pantsInt: 0x2A3040,
    homeX: 0,    homeZ: -3.5,
    homeRotY:    0,
    deskRotY:    Math.PI,
    cameraRotY:  0,
    distanceOpacity: 1.0
  },
  marcus: {
    // Right side of the back row — profile to camera
    name: 'Marcus', role: 'Producer',
    colorHex: '#2D5A3D', colorInt: 0x2D5A3D,
    skinInt: 0xC68642,   pantsInt: 0x1C2820,
    homeX: 1.0,  homeZ: -9,
    homeRotY:    -Math.PI / 2,
    deskRotY:    Math.PI,
    cameraRotY:  -Math.PI / 2,
    distanceOpacity: 0.90
  },
  sarah: {
    // Across from James + Marcus — profile to camera
    name: 'Sarah', role: 'Architect',
    colorHex: '#6B2D3D', colorInt: 0x6B2D3D,
    skinInt: 0xBF8060,   pantsInt: 0x201018,
    homeX: 0.2,  homeZ: -12,
    homeRotY:    -Math.PI / 2,
    deskRotY:    0,
    cameraRotY:  -Math.PI / 2,
    distanceOpacity: 0.85
  },
  james: {
    // Left side of the back row — profile to camera
    name: 'James', role: 'Validator',
    colorHex: '#4A4A4A', colorInt: 0x4A4A4A,
    skinInt: 0xDBA07A,   pantsInt: 0x1A1A22,
    homeX: -0.6, homeZ: -9,
    homeRotY:    -Math.PI / 2,
    deskRotY:    Math.PI,
    cameraRotY:  -Math.PI / 2,
    distanceOpacity: 0.90
  }
}

export function createCharacters(scene) {
  const out = {}
  for (const [key, def] of Object.entries(DEFS)) {
    out[key] = buildCharacter(scene, def)
  }
  return out
}

function buildCharacter(scene, def) {
  const group = new THREE.Group()
  group.position.set(def.homeX, 0, def.homeZ)
  group.rotation.y = def.homeRotY

  const skinMat  = new THREE.MeshLambertMaterial({ color: def.skinInt })
  const torsoMat = new THREE.MeshLambertMaterial({ color: def.colorInt })
  const pantsMat = new THREE.MeshLambertMaterial({ color: def.pantsInt })

  // ── Head pivot (rotates independently for head tracking) ──
  const headPivot = new THREE.Group()
  headPivot.position.y = 1.58
  group.add(headPivot)

  // Head sphere
  const head = new THREE.Mesh(new THREE.SphereGeometry(0.145, 16, 12), skinMat)
  head.castShadow = true
  headPivot.add(head)


  // Neck
  const neck = new THREE.Mesh(new THREE.CylinderGeometry(0.055, 0.065, 0.12, 10), skinMat)
  neck.position.y = 1.38
  neck.castShadow = true
  group.add(neck)

  // Torso
  const torso = new THREE.Mesh(new THREE.BoxGeometry(0.40, 0.54, 0.24), torsoMat)
  torso.position.y = 1.09
  torso.castShadow = true
  group.add(torso)

  // Upper arms
  const upperArmGeo = new THREE.CylinderGeometry(0.055, 0.048, 0.32, 8)
  const lUpperArm = new THREE.Mesh(upperArmGeo, torsoMat)
  lUpperArm.position.set(-0.235, 1.15, 0)
  lUpperArm.rotation.z = 0.13
  lUpperArm.castShadow = true
  group.add(lUpperArm)
  const rUpperArm = new THREE.Mesh(upperArmGeo, torsoMat)
  rUpperArm.position.set(0.235, 1.15, 0)
  rUpperArm.rotation.z = -0.13
  rUpperArm.castShadow = true
  group.add(rUpperArm)

  // Forearms
  const forearmGeo = new THREE.CylinderGeometry(0.044, 0.038, 0.28, 8)
  const lForearm = new THREE.Mesh(forearmGeo, skinMat)
  lForearm.position.set(-0.265, 0.90, 0.04)
  lForearm.rotation.z = 0.22
  lForearm.rotation.x = 0.15
  group.add(lForearm)
  const rForearm = new THREE.Mesh(forearmGeo, skinMat)
  rForearm.position.set(0.265, 0.90, 0.04)
  rForearm.rotation.z = -0.22
  rForearm.rotation.x = 0.15
  group.add(rForearm)

  // Hands
  const handGeo = new THREE.SphereGeometry(0.038, 6, 5)
  const lHand = new THREE.Mesh(handGeo, skinMat)
  lHand.position.set(-0.29, 0.75, 0.08)
  group.add(lHand)
  const rHand = new THREE.Mesh(handGeo, skinMat)
  rHand.position.set(0.29, 0.75, 0.08)
  group.add(rHand)

  // Legs
  const legGeo = new THREE.CylinderGeometry(0.078, 0.072, 0.66, 10)
  const lLeg = new THREE.Mesh(legGeo, pantsMat)
  lLeg.position.set(-0.10, 0.50, 0)
  lLeg.castShadow = true
  group.add(lLeg)
  const rLeg = new THREE.Mesh(legGeo, pantsMat)
  rLeg.position.set(0.10, 0.50, 0)
  rLeg.castShadow = true
  group.add(rLeg)

  // Shoes
  const shoeMat = new THREE.MeshLambertMaterial({ color: 0x1A1510 })
  const shoeGeo = new THREE.BoxGeometry(0.1, 0.06, 0.2)
  const lShoe = new THREE.Mesh(shoeGeo, shoeMat)
  lShoe.position.set(-0.10, 0.08, 0.03)
  group.add(lShoe)
  const rShoe = new THREE.Mesh(shoeGeo, shoeMat)
  rShoe.position.set(0.10, 0.08, 0.03)
  group.add(rShoe)

  // ── Role-color glow light (pulses when working) ───
  const charLight = new THREE.PointLight(def.colorInt, 0, 3.5)
  charLight.position.set(0, 2.1, 0)
  group.add(charLight)

  // ── Thinking dots (3 orbiting dots above head) ────
  const dotMat = new THREE.MeshLambertMaterial({
    color: def.colorInt,
    emissive: def.colorInt,
    emissiveIntensity: 0.6,
    transparent: true,
    opacity: 0
  })
  const dotGeo = new THREE.SphereGeometry(0.022, 6, 4)
  const dotGroup = new THREE.Group()
  dotGroup.position.y = 1.86
  group.add(dotGroup)

  const dots = [
    new THREE.Mesh(dotGeo, dotMat.clone()),
    new THREE.Mesh(dotGeo, dotMat.clone()),
    new THREE.Mesh(dotGeo, dotMat.clone())
  ]
  for (const d of dots) dotGroup.add(d)

  // ── CSS2D name label ──────────────────────────────
  const labelEl = document.createElement('div')
  labelEl.className = 'char-label'
  labelEl.style.color = def.colorHex
  labelEl.style.borderLeftColor = def.colorHex
  labelEl.innerHTML = `<span class="char-name">${def.name}</span><span class="char-role">${def.role}</span>`
  const labelObj = new CSS2DObject(labelEl)
  labelObj.position.set(0, 2.05, 0)
  group.add(labelObj)

  // ── CSS2D status ticker ───────────────────────────
  const tickerEl = document.createElement('div')
  tickerEl.className = 'ticker'
  tickerEl.style.borderLeftColor = def.colorHex
  tickerEl.style.opacity = '0'
  const tickerObj = new CSS2DObject(tickerEl)
  tickerObj.position.set(0, 2.32, 0)
  group.add(tickerObj)

  scene.add(group)

  // ── Animation state ───────────────────────────────
  const state = {
    def, group, headPivot, torso, lForearm, rForearm, lLeg, rLeg, lShoe, rShoe,
    tickerEl, tickerObj, charLight, dots,

    _breathOffset: Math.random() * Math.PI * 2,
    _isWalking: false,
    _walkStartPos: null, _walkTargetPos: null,
    _walkStartTime: 0, _walkDuration: 0, _walkResolve: null,
    _isWorking: false,
    _headLookFn: null,
    _seatOffset: 0,
    _targetSeatOffset: 0,
    _lightIntensity: 0,
    _dotsAlpha: 0,

    update(elapsed) {
      // ── Seat offset lerp ─────────────────────────
      this._seatOffset += (this._targetSeatOffset - this._seatOffset) * 0.07

      // ── Breathing ───────────────────────────────
      const breath = 1 + 0.005 * Math.sin(elapsed * (2 * Math.PI / 3.5) + this._breathOffset)
      this.torso.scale.y = breath

      // ── Walking ─────────────────────────────────
      if (this._isWalking) {
        const t = Math.min(1, (performance.now() - this._walkStartTime) / (this._walkDuration * 1000))
        const e = easeInOut(t)
        this.group.position.lerpVectors(this._walkStartPos, this._walkTargetPos, e)

        const swing = Math.sin(elapsed * 6 + this._breathOffset) * 0.18
        this.lLeg.rotation.x =  swing
        this.rLeg.rotation.x = -swing
        this.lShoe.rotation.x =  swing * 0.5
        this.rShoe.rotation.x = -swing * 0.5
        this.group.position.y = this._seatOffset + Math.abs(Math.sin(elapsed * 6 + this._breathOffset)) * 0.025

        if (t >= 1) {
          this.group.position.x = this._walkTargetPos.x
          this.group.position.z = this._walkTargetPos.z
          // y managed by seatOffset
          this.lLeg.rotation.x = this.rLeg.rotation.x = 0
          this.lShoe.rotation.x = this.rShoe.rotation.x = 0
          this._isWalking = false
          if (this._walkResolve) {
            const r = this._walkResolve
            this._walkResolve = null
            r()
          }
        }
      } else {
        this.group.position.y = this._seatOffset
      }

      // ── Typing animation when working ───────────
      if (this._isWorking) {
        const phase = elapsed * 7 + this._breathOffset
        this.lForearm.rotation.x = 0.55 + 0.1 * Math.sin(phase)
        this.rForearm.rotation.x = 0.55 + 0.1 * Math.sin(phase + Math.PI * 0.7)
        this.lForearm.rotation.z = 0.22
        this.rForearm.rotation.z = -0.22
      } else if (!this._isWalking) {
        this.lForearm.rotation.x = 0.15
        this.rForearm.rotation.x = 0.15
        this.lForearm.rotation.z = 0.22
        this.rForearm.rotation.z = -0.22
      }

      // ── Glow light ───────────────────────────────
      const targetIntensity = this._isWorking ? 0.35 : 0
      this._lightIntensity += (targetIntensity - this._lightIntensity) * 0.05
      const pulse = this._isWorking ? 0.08 * Math.sin(elapsed * 3.5 + this._breathOffset) : 0
      this.charLight.intensity = Math.max(0, this._lightIntensity + pulse)

      // ── Thinking dots ────────────────────────────
      const dotTarget = this._isWorking ? 1 : 0
      this._dotsAlpha += (dotTarget - this._dotsAlpha) * 0.08
      const showDots = this._dotsAlpha > 0.02
      for (let i = 0; i < 3; i++) {
        this.dots[i].visible = showDots
        if (showDots) {
          this.dots[i].material.opacity = this._dotsAlpha
          const angle = elapsed * 2.2 + (i * Math.PI * 2 / 3)
          this.dots[i].position.set(Math.cos(angle) * 0.20, 0, Math.sin(angle) * 0.20)
        }
      }

      // ── Head tracking ────────────────────────────
      if (this._headLookFn) {
        const targetPos = this._headLookFn()
        const savedQ = this.headPivot.quaternion.clone()
        this.headPivot.lookAt(targetPos)
        const targetQ = this.headPivot.quaternion.clone()
        this.headPivot.quaternion.copy(savedQ)
        this.headPivot.quaternion.slerp(targetQ, 0.06)
      } else {
        const swayY = 0.04 * Math.sin(elapsed * 0.38 + this._breathOffset)
        const swayX = 0.015 * Math.sin(elapsed * 0.55 + this._breathOffset * 1.3)
        const idleQ = new THREE.Quaternion().setFromEuler(new THREE.Euler(swayX, swayY, 0))
        this.headPivot.quaternion.slerp(idleQ, 0.025)
      }
    },

    // ── Walk API ─────────────────────────────────
    walkTo(x, z) {
      return new Promise(resolve => {
        if (this._isWalking && this._walkResolve) {
          const old = this._walkResolve; this._walkResolve = null; old()
        }
        const dx = x - this.group.position.x
        const dz = z - this.group.position.z
        const dist = Math.sqrt(dx * dx + dz * dz)
        if (dist < 0.05) { resolve(); return }

        // Auto-stand before walking
        this._targetSeatOffset = 0

        this._walkStartPos  = this.group.position.clone()
        this._walkTargetPos = new THREE.Vector3(x, 0, z)
        this._walkStartTime = performance.now()
        this._walkDuration  = dist / 1.5
        this._isWalking     = true
        this._walkResolve   = resolve
        this.group.rotation.y = Math.atan2(dx, dz)
      })
    },

    faceCamera()         { this.group.rotation.y = def.cameraRotY },
    faceDesk()           { this.group.rotation.y = def.deskRotY },
    faceCharacter(other) {
      const dx = other.group.position.x - this.group.position.x
      const dz = other.group.position.z - this.group.position.z
      this.group.rotation.y = Math.atan2(dx, dz)
    },
    goHome() { return this.walkTo(def.homeX, def.homeZ) },

    // ── Sit / Stand API ──────────────────────────
    sitDown()  { this._targetSeatOffset = -0.38 },
    standUp()  { this._targetSeatOffset = 0 },

    // ── Head look API ────────────────────────────
    setLookTarget(posOrChar) {
      if (!posOrChar) {
        this._headLookFn = null
      } else if (posOrChar instanceof THREE.Vector3) {
        this._headLookFn = () => posOrChar
      } else if (posOrChar.getHeadWorldPos) {
        this._headLookFn = () => posOrChar.getHeadWorldPos()
      }
    },
    clearLookTarget() { this._headLookFn = null },
    getHeadWorldPos() {
      const v = new THREE.Vector3()
      this.headPivot.getWorldPosition(v)
      return v
    },

    // ── Working animation ────────────────────────
    startWorking() { this._isWorking = true },
    stopWorking()  { this._isWorking = false }
  }

  return state
}

function easeInOut(t) {
  return t < 0.5 ? 2 * t * t : -1 + (4 - 2 * t) * t
}
