import * as THREE from 'three'
import { CSS2DObject } from 'three/examples/jsm/renderers/CSS2DRenderer.js'

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

// ── Module-level worker count for ambient dimming ─────────────────────────
let _activeWorkers = 0
let _sceneCtrl = null

export function createCharacters(scene, sceneCtrl, screens) {
  _sceneCtrl = sceneCtrl || null
  const out = {}
  for (const [key, def] of Object.entries(DEFS)) {
    out[key] = buildCharacter(scene, def, screens?.[key] ?? null)
  }
  return out
}

function buildCharacter(scene, def, screenMesh) {
  const group = new THREE.Group()
  group.position.set(def.homeX, 0, def.homeZ)
  group.rotation.y = def.homeRotY

  const skinMat  = new THREE.MeshLambertMaterial({ color: def.skinInt })
  const torsoMat = new THREE.MeshLambertMaterial({ color: def.colorInt })
  const pantsMat = new THREE.MeshLambertMaterial({ color: def.pantsInt })

  // Floor ring — static subtle AO hint, always on
  const ring = new THREE.Mesh(
    new THREE.RingGeometry(0.28, 0.38, 32),
    new THREE.MeshLambertMaterial({
      color: def.colorInt, transparent: true, opacity: 0.12
    })
  )
  ring.rotation.x = -Math.PI / 2
  ring.position.y = 0.01
  group.add(ring)

  // ── Head pivot (rotates independently for head tracking) ──
  const headPivot = new THREE.Group()
  headPivot.position.y = 1.58
  group.add(headPivot)

  const head = new THREE.Mesh(new THREE.SphereGeometry(0.145, 16, 12), skinMat)
  head.castShadow = true
  headPivot.add(head)

  const neck = new THREE.Mesh(new THREE.CylinderGeometry(0.055, 0.065, 0.12, 10), skinMat)
  neck.position.y = 1.38
  neck.castShadow = true
  group.add(neck)

  const torso = new THREE.Mesh(new THREE.BoxGeometry(0.40, 0.54, 0.24), torsoMat)
  torso.position.y = 1.09
  torso.castShadow = true
  group.add(torso)

  const upperArmGeo = new THREE.CylinderGeometry(0.055, 0.048, 0.32, 8)
  const forearmGeo  = new THREE.CylinderGeometry(0.044, 0.038, 0.28, 8)
  const handGeo     = new THREE.SphereGeometry(0.038, 6, 5)

  // Left arm hierarchy: shoulderPivot → upperArm + elbowPivot → forearm + hand
  const lShoulderPivot = new THREE.Group()
  lShoulderPivot.position.set(-0.26, 1.32, 0)
  lShoulderPivot.rotation.z = 0.45
  lShoulderPivot.rotation.x = 0.25
  group.add(lShoulderPivot)
  const lUpperArm = new THREE.Mesh(upperArmGeo, torsoMat)
  lUpperArm.position.set(0, -0.16, 0)
  lUpperArm.castShadow = true
  lShoulderPivot.add(lUpperArm)
  const lElbowPivot = new THREE.Group()
  lElbowPivot.position.set(0, -0.32, 0)
  lElbowPivot.rotation.x = 0.85
  lShoulderPivot.add(lElbowPivot)
  const lForearm = new THREE.Mesh(forearmGeo, skinMat)
  lForearm.position.set(0, -0.14, 0)
  lElbowPivot.add(lForearm)
  const lHand = new THREE.Mesh(handGeo, skinMat)
  lHand.position.set(0, -0.28, 0)
  lElbowPivot.add(lHand)

  // Right arm hierarchy
  const rShoulderPivot = new THREE.Group()
  rShoulderPivot.position.set(0.26, 1.32, 0)
  rShoulderPivot.rotation.z = -0.45
  rShoulderPivot.rotation.x = 0.25
  group.add(rShoulderPivot)
  const rUpperArm = new THREE.Mesh(upperArmGeo, torsoMat)
  rUpperArm.position.set(0, -0.16, 0)
  rUpperArm.castShadow = true
  rShoulderPivot.add(rUpperArm)
  const rElbowPivot = new THREE.Group()
  rElbowPivot.position.set(0, -0.32, 0)
  rElbowPivot.rotation.x = 0.85
  rShoulderPivot.add(rElbowPivot)
  const rForearm = new THREE.Mesh(forearmGeo, skinMat)
  rForearm.position.set(0, -0.14, 0)
  rElbowPivot.add(rForearm)
  const rHand = new THREE.Mesh(handGeo, skinMat)
  rHand.position.set(0, -0.28, 0)
  rElbowPivot.add(rHand)

  const legGeo = new THREE.CylinderGeometry(0.078, 0.072, 0.66, 10)
  const lLeg = new THREE.Mesh(legGeo, pantsMat)
  lLeg.position.set(-0.10, 0.50, 0)
  lLeg.castShadow = true
  group.add(lLeg)
  const rLeg = new THREE.Mesh(legGeo, pantsMat)
  rLeg.position.set(0.10, 0.50, 0)
  rLeg.castShadow = true
  group.add(rLeg)

  const shoeMat = new THREE.MeshLambertMaterial({ color: 0x1A1510 })
  const shoeGeo = new THREE.BoxGeometry(0.1, 0.06, 0.2)
  const lShoe = new THREE.Mesh(shoeGeo, shoeMat)
  lShoe.position.set(-0.10, 0.08, 0.03)
  group.add(lShoe)
  const rShoe = new THREE.Mesh(shoeGeo, shoeMat)
  rShoe.position.set(0.10, 0.08, 0.03)
  group.add(rShoe)

  // ── Ceiling spotlight — role color, off when idle, lerps on when working ──
  // Brighten the role color so the spotlight actually reads — dark navy/green are near-black
  const spotColor = new THREE.Color(def.colorInt).lerp(new THREE.Color(0xffffff), 0.65)
  const spotLight = new THREE.SpotLight(spotColor, 0)
  spotLight.position.set(def.homeX, 4.5, def.homeZ)
  spotLight.angle    = 0.4
  spotLight.penumbra = 0.3
  spotLight.decay    = 0
  spotLight.castShadow = false
  scene.add(spotLight)

  const spotTarget = new THREE.Object3D()
  spotTarget.position.set(def.homeX, 1.2, def.homeZ)
  scene.add(spotTarget)
  spotLight.target = spotTarget

  // ── Visible light cone — truncated cylinder, wide at bottom ──────────────
  const coneMat = new THREE.MeshBasicMaterial({
    color: spotColor,
    transparent: true,
    opacity: 0,
    side: THREE.BackSide,
    blending: THREE.AdditiveBlending,
    depthWrite: false
  })
  const coneMesh = new THREE.Mesh(
    new THREE.CylinderGeometry(0.12, 1.2, 4.5, 24, 1, true),
    coneMat
  )
  coneMesh.position.y = 2.25   // centered between floor (0) and ceiling (4.5)
  group.add(coneMesh)

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
  tickerObj.visible = false
  tickerEl._css2dObj = tickerObj
  group.add(tickerObj)

  scene.add(group)

  // ── Animation state ───────────────────────────────
  const state = {
    def, group, headPivot, torso, lElbowPivot, rElbowPivot, lLeg, rLeg, lShoe, rShoe,
    tickerEl, tickerObj, spotLight, spotTarget, coneMesh, screenMesh, labelEl,

    _breathOffset: Math.random() * Math.PI * 2,
    _isWalking: false,
    _walkStartPos: null, _walkTargetPos: null,
    _walkStartTime: 0, _walkDuration: 0, _walkResolve: null,
    _isWorking: false,
    _headLookFn: null,
    _seatOffset: 0,
    _targetSeatOffset: 0,
    _spotIntensity: 0,
    _coneOpacity: 0,
    _torsoPitch: 0,

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
        this.lElbowPivot.rotation.x = 0.85 + 0.1 * Math.sin(phase)
        this.rElbowPivot.rotation.x = 0.85 + 0.1 * Math.sin(phase + Math.PI * 0.7)
      } else if (!this._isWalking) {
        this.lElbowPivot.rotation.x = 0.85
        this.rElbowPivot.rotation.x = 0.85
      }

      // ── Ceiling spotlight ─────────────────────────
      const targetIntensity = this._isWorking ? 8.0 : 0
      this._spotIntensity += (targetIntensity - this._spotIntensity) * 0.06
      this.spotLight.intensity = this._spotIntensity
      // Track character X/Z so spotlight follows Delma when she walks
      this.spotLight.position.x  = this.group.position.x
      this.spotLight.position.z  = this.group.position.z
      this.spotTarget.position.x = this.group.position.x
      this.spotTarget.position.z = this.group.position.z

      // ── Visible cone of light ─────────────────────
      const coneTarget = this._isWorking ? 0.13 : 0
      this._coneOpacity += (coneTarget - this._coneOpacity) * 0.06
      this.coneMesh.material.opacity = this._coneOpacity

      // ── Forward lean when working ─────────────────
      const pitchTarget = this._isWorking ? 0.08 : 0
      this._torsoPitch += (pitchTarget - this._torsoPitch) * 0.06
      this.torso.rotation.x = this._torsoPitch

      // ── Screen glow ───────────────────────────────
      if (this.screenMesh) {
        const intensityTarget = this._isWorking ? 1.5 : 1.0
        this.screenMesh.material.emissiveIntensity +=
          (intensityTarget - this.screenMesh.material.emissiveIntensity) * 0.06
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
    startWorking() {
      this._isWorking = true
      this.labelEl.classList.add('char-label-active')
      if (this.screenMesh) this.screenMesh.material.emissive.setHex(this.def.colorInt)
      _activeWorkers++
      if (_activeWorkers === 1 && _sceneCtrl) _sceneCtrl.setWorkMode(true)
    },
    stopWorking() {
      this._isWorking = false
      this.labelEl.classList.remove('char-label-active')
      if (this.screenMesh) this.screenMesh.material.emissive.setHex(0x0A1835)
      _activeWorkers = Math.max(0, _activeWorkers - 1)
      if (_activeWorkers === 0 && _sceneCtrl) _sceneCtrl.setWorkMode(false)
    }
  }

  return state
}

function easeInOut(t) {
  return t < 0.5 ? 2 * t * t : -1 + (4 - 2 * t) * t
}
