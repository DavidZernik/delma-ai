import * as THREE from 'three'
import { CSS2DRenderer } from 'three/examples/jsm/renderers/CSS2DRenderer.js'

export const LEFT_FRAC = 0.40

export function initScene() {
  const scene = new THREE.Scene()
  scene.background = new THREE.Color(0xD8D4CE)
  scene.fog = new THREE.Fog(0xD8D4CE, 20, 35)

  // ── Camera — elevated front-left, sees all 4 characters ──────────────────
  const w = Math.round(window.innerWidth * LEFT_FRAC)
  const h = window.innerHeight
  const camera = new THREE.PerspectiveCamera(65, w / h, 0.1, 40)
  camera.position.set(0.5, 3.5, -0.5)
  camera.lookAt(0.3, 1.0, -9)

  // ── Renderers ────────────────────────────────────
  const renderer = new THREE.WebGLRenderer({ antialias: true })
  renderer.setSize(w, h)
  renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2))
  renderer.shadowMap.enabled = true
  renderer.shadowMap.type = THREE.PCFSoftShadowMap
  document.getElementById('canvas-container').appendChild(renderer.domElement)

  const css2dRenderer = new CSS2DRenderer()
  css2dRenderer.setSize(w, h)
  css2dRenderer.domElement.style.position = 'absolute'
  css2dRenderer.domElement.style.top = '0'
  css2dRenderer.domElement.style.left = '0'
  css2dRenderer.domElement.style.pointerEvents = 'none'
  document.getElementById('canvas-container').appendChild(css2dRenderer.domElement)

  // ── Lighting ─────────────────────────────────────
  const ambientLight = new THREE.AmbientLight(0xFFF5E8, 0.80)
  scene.add(ambientLight)

  // Ceiling simulation — warm overhead
  const mainLight = new THREE.DirectionalLight(0xFFFAF0, 0.50)
  mainLight.position.set(0, 8, -5)
  mainLight.castShadow = true
  mainLight.shadow.mapSize.set(2048, 2048)
  mainLight.shadow.camera.near = 0.5
  mainLight.shadow.camera.far = 35
  mainLight.shadow.camera.left = -7
  mainLight.shadow.camera.right = 7
  mainLight.shadow.camera.top = 7
  mainLight.shadow.camera.bottom = -7
  scene.add(mainLight)

  // Fill from camera position — warms faces visible to camera
  const fillLight = new THREE.DirectionalLight(0xFFEAD0, 0.40)
  fillLight.position.set(-4, 5, 1)
  fillLight.target.position.set(0, 1, -8)
  scene.add(fillLight)
  scene.add(fillLight.target)

  // ── Room ─────────────────────────────────────────
  const screens = buildRoom(scene)

  // ── Ambient dimming controller ────────────────────────────────────────
  let _ambTarget = 0.70, _dirTarget = 0.50
  const lightsController = {
    setWorkMode(active) {
      _ambTarget = active ? 0.12 : 0.70
      _dirTarget = active ? 0.15 : 0.50
    },
    tick() {
      ambientLight.intensity += (_ambTarget - ambientLight.intensity) * 0.05
      mainLight.intensity    += (_dirTarget - mainLight.intensity)    * 0.05
    }
  }

  const clock = new THREE.Clock()
  return { scene, camera, renderer, css2dRenderer, clock, lightsController, screens }
}

// ── Room ──────────────────────────────────────────────────────────────────

function buildRoom(scene) {
  const ROOM_W = 9, ROOM_H = 5, ROOM_D = 20

  // ── Floor — rich dark herringbone oak ──────────
  const floorTex = makeFloorTexture()
  const floorMat = new THREE.MeshLambertMaterial({ map: floorTex })
  const floor = new THREE.Mesh(new THREE.PlaneGeometry(ROOM_W, ROOM_D), floorMat)
  floor.rotation.x = -Math.PI / 2
  floor.position.set(0, 0, -ROOM_D / 2)
  floor.receiveShadow = true
  scene.add(floor)

  // ── Ceiling — white with subtle warm tone ───────
  const ceilMat = new THREE.MeshLambertMaterial({ color: 0xDDD8D0 })
  const ceil = new THREE.Mesh(new THREE.PlaneGeometry(ROOM_W, ROOM_D), ceilMat)
  ceil.rotation.x = Math.PI / 2
  ceil.position.set(0, ROOM_H, -ROOM_D / 2)
  scene.add(ceil)

  // ── Walls ─────────────────────────────────────
  // Back wall — panels around large window opening
  addBackWindow(scene, ROOM_W, ROOM_H, ROOM_D)

  // Left wall — warm greige
  const leftWallMat = new THREE.MeshLambertMaterial({ color: 0xE8E2D8 })
  const leftWall = new THREE.Mesh(new THREE.PlaneGeometry(ROOM_D, ROOM_H), leftWallMat)
  leftWall.position.set(-ROOM_W / 2, ROOM_H / 2, -ROOM_D / 2)
  leftWall.rotation.y = Math.PI / 2
  scene.add(leftWall)

  // Front wall — warm greige
  const frontWallMat = new THREE.MeshLambertMaterial({ color: 0xE8E2D8 })
  const frontWall = new THREE.Mesh(new THREE.PlaneGeometry(ROOM_W, ROOM_H), frontWallMat)
  frontWall.position.set(0, ROOM_H / 2, 0)
  frontWall.rotation.y = Math.PI
  scene.add(frontWall)

  // Right wall — full glass conference wall + office behind
  addGlassWall(scene, ROOM_W / 2, ROOM_H, ROOM_D)

  // ── Wainscoting — lower wall panels for richness ─
  addWainscoting(scene, ROOM_W, ROOM_H, ROOM_D)

  // ── Ceiling trim / cornice ──────────────────────
  addCornice(scene, ROOM_W, ROOM_H, ROOM_D)

  // ── Pendant lights ───────────────────────────────
  addPendant(scene,  0,    ROOM_H, -3.5)   // Over Sarah
  addPendant(scene, -1.5,  ROOM_H, -9)     // Over James
  addPendant(scene,  1.8,  ROOM_H, -9)     // Over Marcus
  addPendant(scene,  0.2,  ROOM_H, -14)    // Over Priya
  addPendant(scene,  0,    ROOM_H, -6)     // Aisle fill
  addPendant(scene,  0,    ROOM_H, -16)    // Back fill

  // ── Furniture ────────────────────────────────────
  const screens = {
    delma:  addDesk(scene,  0,    -3.5,  2.4, true,  false),
    james:  addDesk(scene, -1.5,  -9,    1.4, false, false),
    marcus: addDesk(scene,  1.8,  -9,    1.4, false, false),
    sarah:  addDesk(scene,  0.2,  -14,   1.4, false, true)
  }

  // Chairs
  addChair(scene, -1.5, -9,   false)  // James
  addChair(scene,  1.8, -9,   false)  // Marcus
  addChair(scene,  0.2, -14,  true)   // Priya — reversed chair (on -Z side)

  // ── Paintings ───────────────────────────────────
  // Left wall — gallery-style arrangement
  addPainting(scene, -4.35, 2.8, -2.5,   'left', 'colorfield')
  addPainting(scene, -4.35, 2.5, -5.5,   'left', 'botanical', true)
  addPainting(scene, -4.35, 2.8, -8.5,   'left', 'gestural')
  addPainting(scene, -4.35, 2.5, -11.5,  'left', 'geometric')
  addPainting(scene, -4.35, 2.8, -17,    'left', 'colorfield')

  // ── Whiteboard (left wall, mid-room) ─────────────
  addWhiteboard(scene, -4.3, 2.1, -14)

  // ── Wall shelves on left wall ────────────────────
  addWallShelf(scene, -4.35, 1.6, -7)
  addWallShelf(scene, -4.35, 1.6, -18)

  // ── Coffee station (front wall) ───────────────────
  addCoffeeStation(scene, -2.5, -0.3)

  // ── Wall clock (left wall) ──────────────────────
  addWallClock(scene, -4.34, 3.6, -6.5)

  // ── Plants ───────────────────────────────────────
  addPlant(scene,  3.4,  -1.5, 2.4)
  addPlant(scene, -4.0,  -1.5, 2.4)
  addPlant(scene, -4.0,  -14,  2.0)
  addPlant(scene,  3.4,  -17,  2.0)

  // divider removed

  // ── Area rug ─────────────────────────────────────
  addRug(scene, 0.2, -11, 7.5, 11)
  return screens
}

// ── Helpers ───────────────────────────────────────────────────────────────

function addWall(scene, geo, x, y, z, ry) {
  const mat = new THREE.MeshLambertMaterial({ color: 0xF8F7F5 })
  const mesh = new THREE.Mesh(geo, mat)
  mesh.position.set(x, y, z)
  mesh.rotation.y = ry
  scene.add(mesh)
}

function addGlassWall(scene, wallX, roomH, roomD) {
  const glassMat = new THREE.MeshLambertMaterial({
    color: 0xD0E0EC, transparent: true, opacity: 0.18,
    emissive: 0x90B0CC, emissiveIntensity: 0.15
  })
  const frameMat = new THREE.MeshLambertMaterial({ color: 0x888888 })
  const kickMat  = new THREE.MeshLambertMaterial({ color: 0xE8E6E2 })

  // Full glass panel
  const glassH = roomH - 0.6  // glass starts above a kick plate
  const glass = new THREE.Mesh(new THREE.PlaneGeometry(roomD, glassH), glassMat)
  glass.rotation.y = -Math.PI / 2
  glass.position.set(wallX - 0.02, 0.6 + glassH / 2, -roomD / 2)
  scene.add(glass)

  // Kick plate at bottom
  const kick = new THREE.Mesh(new THREE.BoxGeometry(0.06, 0.6, roomD), kickMat)
  kick.position.set(wallX, 0.3, -roomD / 2)
  scene.add(kick)

  // Vertical mullions — thin dark metal
  const mullionPositions = [0, -4, -8, -12, -16, -roomD]
  for (const mz of mullionPositions) {
    const mullion = new THREE.Mesh(new THREE.BoxGeometry(0.05, roomH, 0.04), frameMat)
    mullion.position.set(wallX, roomH / 2, mz)
    scene.add(mullion)
  }

  // Top rail
  const topRail = new THREE.Mesh(new THREE.BoxGeometry(0.04, 0.05, roomD), frameMat)
  topRail.position.set(wallX, roomH - 0.025, -roomD / 2)
  scene.add(topRail)

  // Horizontal mid-rail
  const midRail = new THREE.Mesh(new THREE.BoxGeometry(0.04, 0.03, roomD), frameMat)
  midRail.position.set(wallX, 0.6, -roomD / 2)
  scene.add(midRail)

  // Soft light from the office space beyond
  const officeLight = new THREE.PointLight(0xFFF8F0, 0.8, 14)
  officeLight.position.set(wallX + 3, 3.5, -roomD / 2)
  scene.add(officeLight)

  // ── Office space behind glass ──────────────────
  addOfficeBeyondGlass(scene, wallX, roomH, roomD)
}

function addOfficeBeyondGlass(scene, wallX, roomH, roomD) {
  const offX = wallX + 0.5  // just beyond the glass

  // Office floor
  const floorMat = new THREE.MeshLambertMaterial({ color: 0x9A8060 })
  const offFloor = new THREE.Mesh(new THREE.PlaneGeometry(8, roomD), floorMat)
  offFloor.rotation.x = -Math.PI / 2
  offFloor.position.set(wallX + 4, 0.001, -roomD / 2)
  scene.add(offFloor)

  // Office ceiling
  const ceilMat = new THREE.MeshLambertMaterial({ color: 0xDDD8D0 })
  const offCeil = new THREE.Mesh(new THREE.PlaneGeometry(8, roomD), ceilMat)
  offCeil.rotation.x = Math.PI / 2
  offCeil.position.set(wallX + 4, roomH, -roomD / 2)
  scene.add(offCeil)

  // Far wall — dark warm tone so it reads clearly through glass
  const farWallMat = new THREE.MeshLambertMaterial({ color: 0x6A6058 })
  const farWall = new THREE.Mesh(new THREE.PlaneGeometry(roomD, roomH), farWallMat)
  farWall.rotation.y = -Math.PI / 2  // faces -X toward glass
  farWall.position.set(wallX + 8, roomH / 2, -roomD / 2)
  scene.add(farWall)

  // End walls to close off the office space
  const endWallMat = new THREE.MeshLambertMaterial({ color: 0x8A8078 })
  const frontEndWall = new THREE.Mesh(new THREE.PlaneGeometry(8, roomH), endWallMat)
  frontEndWall.rotation.y = Math.PI
  frontEndWall.position.set(wallX + 4, roomH / 2, 0)
  scene.add(frontEndWall)

  // Paintings on front end wall (faces -Z into the office)
  addEndWallPaintingReversed(scene, wallX + 3, 2.6, -0.04, 'colorfield')
  addEndWallPaintingReversed(scene, wallX + 6, 2.6, -0.04, 'geometric')

  const backEndWall = new THREE.Mesh(new THREE.PlaneGeometry(8, roomH), endWallMat)
  backEndWall.position.set(wallX + 4, roomH / 2, -roomD)
  scene.add(backEndWall)

  // Paintings on back end wall (faces +Z toward camera)
  const backEndZ = -roomD + 0.04
  addEndWallPainting(scene, wallX + 2.5, 2.6, backEndZ, 'gestural')
  addEndWallPainting(scene, wallX + 5.5, 2.6, backEndZ, 'botanical')

  // Light to illuminate back end wall art
  const backEndLight = new THREE.PointLight(0xFFF8F0, 0.8, 5)
  backEndLight.position.set(wallX + 4, 3.8, -roomD + 1.5)
  scene.add(backEndLight)

  // Office ambient light — brighter to illuminate far wall
  const ambLight = new THREE.PointLight(0xFFF5E8, 1.2, 14)
  ambLight.position.set(wallX + 6, 4, -10)
  scene.add(ambLight)
  const ambLight2 = new THREE.PointLight(0xFFF5E8, 0.8, 12)
  ambLight2.position.set(wallX + 6, 4, -4)
  scene.add(ambLight2)
  const ambLight3 = new THREE.PointLight(0xFFF5E8, 0.8, 12)
  ambLight3.position.set(wallX + 6, 4, -16)
  scene.add(ambLight3)

  // ── Windows on far office wall ─────────────────
  const farWallX = wallX + 7.98
  const offGlassMat = new THREE.MeshLambertMaterial({
    color: 0xB8D0E0, transparent: true, opacity: 0.4,
    emissive: 0x90B8D0, emissiveIntensity: 0.5
  })
  const offFrameMat = new THREE.MeshLambertMaterial({ color: 0x666060 })
  for (const wz of [-6.5, -13.5]) {
    // Window frame
    const frame = new THREE.Mesh(new THREE.BoxGeometry(0.06, 2.4, 1.8), offFrameMat)
    frame.position.set(farWallX - 0.02, 2.5, wz); scene.add(frame)
    // Glass pane
    const glass = new THREE.Mesh(new THREE.PlaneGeometry(1.6, 2.2), offGlassMat)
    glass.rotation.y = -Math.PI / 2
    glass.position.set(farWallX - 0.05, 2.5, wz); scene.add(glass)
    // Light spill from windows
    const winLight = new THREE.PointLight(0xE8F0FF, 0.6, 6)
    winLight.position.set(farWallX - 1, 2.5, wz); scene.add(winLight)
  }

  // ── Big paintings on far office wall ───────────
  addFarWallPainting(scene, farWallX, 2.5, -3,  'colorfield')
  addFarWallPainting(scene, farWallX, 2.5, -10, 'gestural')
  addFarWallPainting(scene, farWallX, 2.5, -17, 'geometric')

  // ── Static office workers at desks ─────────────
  const workerDefs = [
    { x: offX + 2.0, z: -3,   rot: Math.PI / 2,  skin: 0xC68642, shirt: 0x3A5A8A, pants: 0x2A2A30 },
    { x: offX + 3.5, z: -6,   rot: -Math.PI / 2, skin: 0xDBA07A, shirt: 0x6B4A5A, pants: 0x1E1E28 },
    { x: offX + 2.0, z: -10,  rot: Math.PI / 2,  skin: 0xBF8060, shirt: 0x2D5A3D, pants: 0x20201A },
    { x: offX + 3.5, z: -13,  rot: -Math.PI / 2, skin: 0xD4956A, shirt: 0x4A4A6A, pants: 0x2A2A30 },
    { x: offX + 2.0, z: -16,  rot: Math.PI / 2,  skin: 0xC68642, shirt: 0x5A3A2A, pants: 0x1A1A22 },
    { x: offX + 3.5, z: -18,  rot: -Math.PI / 2, skin: 0xBF8060, shirt: 0x3A5A5A, pants: 0x22222A },
  ]

  const deskMat    = new THREE.MeshLambertMaterial({ color: 0xD0C4B0 })
  const deskLegMat = new THREE.MeshLambertMaterial({ color: 0xA0A0A0 })
  const monMat     = new THREE.MeshLambertMaterial({ color: 0x1A1A1A })
  const screenMat  = new THREE.MeshLambertMaterial({ color: 0x1E3050, emissive: 0x0A1835, emissiveIntensity: 0.8 })
  const chairMat   = new THREE.MeshLambertMaterial({ color: 0x2A2A2A })

  for (const w of workerDefs) {
    const skinMat  = new THREE.MeshLambertMaterial({ color: w.skin })
    const shirtMat = new THREE.MeshLambertMaterial({ color: w.shirt })
    const pantsMat = new THREE.MeshLambertMaterial({ color: w.pants })

    // Simple desk — modern/minimal
    const dTop = new THREE.Mesh(new THREE.BoxGeometry(1.2, 0.04, 0.6), deskMat)
    dTop.position.set(w.x, 0.78, w.z); scene.add(dTop)
    // Desk legs — thin metal
    for (const [lx, lz] of [[-0.55, -0.25], [-0.55, 0.25], [0.55, -0.25], [0.55, 0.25]]) {
      const leg = new THREE.Mesh(new THREE.CylinderGeometry(0.015, 0.015, 0.78, 6), deskLegMat)
      leg.position.set(w.x + lx, 0.39, w.z + lz); scene.add(leg)
    }

    // Monitor
    const monZ = w.rot > 0 ? w.z - 0.18 : w.z + 0.18
    const mon = new THREE.Mesh(new THREE.BoxGeometry(0.4, 0.28, 0.02), monMat)
    mon.position.set(w.x, 1.05, monZ); scene.add(mon)
    const scr = new THREE.Mesh(new THREE.PlaneGeometry(0.36, 0.24), screenMat)
    scr.position.set(w.x, 1.05, w.rot > 0 ? monZ + 0.012 : monZ - 0.012)
    scr.rotation.y = w.rot > 0 ? 0 : Math.PI
    scene.add(scr)

    // Office chair (simple)
    const chairZ = w.rot > 0 ? w.z + 0.30 : w.z - 0.30
    const seat = new THREE.Mesh(new THREE.CylinderGeometry(0.22, 0.22, 0.06, 10), chairMat)
    seat.position.set(w.x, 0.50, chairZ); scene.add(seat)
    const chairBack = new THREE.Mesh(new THREE.BoxGeometry(0.40, 0.38, 0.04), chairMat)
    chairBack.position.set(w.x, 0.74, w.rot > 0 ? chairZ + 0.18 : chairZ - 0.18)
    scene.add(chairBack)

    // Static seated person — simplified figure
    const personZ = chairZ

    // Torso (seated)
    const torso = new THREE.Mesh(new THREE.BoxGeometry(0.34, 0.42, 0.24), shirtMat)
    torso.position.set(w.x, 0.75, personZ); scene.add(torso)

    // Head
    const head = new THREE.Mesh(new THREE.SphereGeometry(0.12, 8, 6), skinMat)
    head.position.set(w.x, 1.10, personZ); scene.add(head)

    // Arms resting on desk
    const armY = 0.80
    for (const side of [-1, 1]) {
      const arm = new THREE.Mesh(new THREE.BoxGeometry(0.09, 0.09, 0.28), shirtMat)
      arm.position.set(w.x + side * 0.22, armY, w.rot > 0 ? personZ - 0.16 : personZ + 0.16)
      scene.add(arm)
      // Hand
      const hand = new THREE.Mesh(new THREE.SphereGeometry(0.045, 6, 4), skinMat)
      hand.position.set(w.x + side * 0.22, armY, w.rot > 0 ? personZ - 0.32 : personZ + 0.32)
      scene.add(hand)
    }

    // Legs (under desk)
    for (const side of [-1, 1]) {
      const leg = new THREE.Mesh(new THREE.BoxGeometry(0.12, 0.48, 0.14), pantsMat)
      leg.position.set(w.x + side * 0.10, 0.28, personZ)
      scene.add(leg)
    }
  }

  // ── Standing person at whiteboard ──────────────
  addStandingPerson(scene, wallX + 7.4, -8.5)

  // ── Office whiteboard ─────────────────────────
  const obMat = new THREE.MeshLambertMaterial({ color: 0xF0EDE8, emissive: 0x080806, emissiveIntensity: 0.05 })
  const oBoard = new THREE.Mesh(new THREE.BoxGeometry(0.04, 1.2, 1.8), obMat)
  oBoard.position.set(wallX + 7.94, 2.0, -8.5); scene.add(oBoard)
  const oBoardFrame = new THREE.Mesh(new THREE.BoxGeometry(0.05, 1.28, 1.88),
    new THREE.MeshLambertMaterial({ color: 0x888888 }))
  oBoardFrame.position.set(wallX + 7.96, 2.0, -8.5); scene.add(oBoardFrame)
}

function addStandingPerson(scene, x, z) {
  const skinMat  = new THREE.MeshLambertMaterial({ color: 0xD4956A })
  const shirtMat = new THREE.MeshLambertMaterial({ color: 0x4A3A6A })
  const pantsMat = new THREE.MeshLambertMaterial({ color: 0x1E1E28 })
  const shoeMat  = new THREE.MeshLambertMaterial({ color: 0x1A1A1A })

  // Legs
  for (const side of [-1, 1]) {
    const leg = new THREE.Mesh(new THREE.BoxGeometry(0.12, 0.80, 0.14), pantsMat)
    leg.position.set(x, 0.40, z + side * 0.08); scene.add(leg)
    const shoe = new THREE.Mesh(new THREE.BoxGeometry(0.13, 0.06, 0.20), shoeMat)
    shoe.position.set(x, 0.03, z + side * 0.08); scene.add(shoe)
  }

  // Torso
  const torso = new THREE.Mesh(new THREE.BoxGeometry(0.36, 0.50, 0.24), shirtMat)
  torso.position.set(x, 1.08, z); scene.add(torso)

  // Head
  const head = new THREE.Mesh(new THREE.SphereGeometry(0.12, 8, 6), skinMat)
  head.position.set(x, 1.48, z); scene.add(head)

  // Arm raised toward whiteboard
  const armUp = new THREE.Mesh(new THREE.BoxGeometry(0.09, 0.38, 0.09), shirtMat)
  armUp.rotation.z = -0.4
  armUp.position.set(x - 0.10, 1.35, z - 0.08); scene.add(armUp)
  const handUp = new THREE.Mesh(new THREE.SphereGeometry(0.04, 6, 4), skinMat)
  handUp.position.set(x - 0.18, 1.52, z - 0.08); scene.add(handUp)

  // Other arm relaxed at side
  const armDown = new THREE.Mesh(new THREE.BoxGeometry(0.09, 0.34, 0.09), shirtMat)
  armDown.position.set(x, 0.92, z + 0.14); scene.add(armDown)
}

function addWainscoting(scene, w, h, d) {
  const panelH = 1.0
  const panelMat = new THREE.MeshLambertMaterial({ color: 0xC8BDA8 })
  const capMat   = new THREE.MeshLambertMaterial({ color: 0xB8AD98 })

  // Left wall wainscoting
  const leftPanel = new THREE.Mesh(new THREE.PlaneGeometry(d, panelH), panelMat)
  leftPanel.rotation.y = Math.PI / 2
  leftPanel.position.set(-w / 2 + 0.01, panelH / 2, -d / 2)
  scene.add(leftPanel)

  // Cap rail on left wall
  const leftCap = new THREE.Mesh(new THREE.BoxGeometry(0.06, 0.04, d), capMat)
  leftCap.position.set(-w / 2 + 0.03, panelH, -d / 2)
  scene.add(leftCap)

  // Front wall wainscoting
  const frontPanel = new THREE.Mesh(new THREE.PlaneGeometry(w, panelH), panelMat)
  frontPanel.rotation.y = Math.PI
  frontPanel.position.set(0, panelH / 2, -0.01)
  scene.add(frontPanel)

  const frontCap = new THREE.Mesh(new THREE.BoxGeometry(w, 0.04, 0.06), capMat)
  frontCap.position.set(0, panelH, -0.03)
  scene.add(frontCap)
}

function addCornice(scene, w, h, d) {
  const mat = new THREE.MeshLambertMaterial({ color: 0xCCC8C0 })
  const height = 0.1
  const geo = new THREE.BoxGeometry(w, height, 0.12)
  const front = new THREE.Mesh(geo, mat); front.position.set(0, h - height / 2, 0); scene.add(front)
  const back  = new THREE.Mesh(geo, mat); back.position.set(0, h - height / 2, -d); scene.add(back)
  const lGeo  = new THREE.BoxGeometry(0.12, height, d)
  const left  = new THREE.Mesh(lGeo, mat); left.position.set(-w / 2, h - height / 2, -d / 2); scene.add(left)
  const right = new THREE.Mesh(lGeo, mat); right.position.set(w / 2, h - height / 2, -d / 2); scene.add(right)
}

function addPendant(scene, x, ceilY, z) {
  const cordMat  = new THREE.MeshLambertMaterial({ color: 0x222018 })
  const shadeMat = new THREE.MeshLambertMaterial({ color: 0x2E2C26, side: THREE.BackSide })
  const shadeInnerMat = new THREE.MeshLambertMaterial({ color: 0xFFE8B0, emissive: 0xFFD080, emissiveIntensity: 0.6 })
  const bulbMat  = new THREE.MeshLambertMaterial({ color: 0xFFEEAA, emissive: 0xFFEEAA, emissiveIntensity: 4.0 })

  const y = ceilY - 0.05
  const cord = new THREE.Mesh(new THREE.CylinderGeometry(0.005, 0.005, 0.65, 6), cordMat)
  cord.position.set(x, y - 0.33, z); scene.add(cord)

  const shade = new THREE.Mesh(new THREE.CylinderGeometry(0.22, 0.06, 0.20, 16), shadeMat)
  shade.position.set(x, y - 0.76, z); scene.add(shade)

  // Inner shade surface catches light warmly
  const shadeInner = new THREE.Mesh(new THREE.CylinderGeometry(0.21, 0.055, 0.19, 16), shadeInnerMat)
  shadeInner.position.set(x, y - 0.76, z); scene.add(shadeInner)

  const rim = new THREE.Mesh(new THREE.TorusGeometry(0.215, 0.010, 8, 24),
    new THREE.MeshLambertMaterial({ color: 0x8A7A60 }))
  rim.rotation.x = Math.PI / 2; rim.position.set(x, y - 0.67, z); scene.add(rim)

  const bulb = new THREE.Mesh(new THREE.SphereGeometry(0.045, 8, 6), bulbMat)
  bulb.position.set(x, y - 0.76, z); scene.add(bulb)

  // Main downward pool of light
  const light = new THREE.PointLight(0xFFD890, 3.5, 12)
  light.position.set(x, y - 0.84, z); scene.add(light)

  // Subtle upward spill above the shade
  const spill = new THREE.PointLight(0xFFE0A0, 0.6, 5)
  spill.position.set(x, y - 0.60, z); scene.add(spill)
}

function addDesk(scene, x, z, width, isReception, reversed) {
  // reversed = true means character faces +Z (e.g. Priya), monitor on +Z side
  const topMat    = new THREE.MeshLambertMaterial({ color: 0x6B4C32 })  // dark walnut
  const deskMat   = new THREE.MeshLambertMaterial({ color: 0x5A3E28 })
  const legMat    = new THREE.MeshLambertMaterial({ color: 0x3A2818 })
  const monMat    = new THREE.MeshLambertMaterial({ color: 0x1A1A1A })
  const screenMat = new THREE.MeshLambertMaterial({ color: 0x1E3050, emissive: 0x0A1835, emissiveIntensity: 1.0 })

  const DH = 0.82
  const zSign = reversed ? 1 : -1   // flip Z offsets for reversed desks
  let screenMesh = null

  const top = new THREE.Mesh(new THREE.BoxGeometry(width, 0.05, 0.78), topMat)
  top.position.set(x, DH + 0.025, z)
  top.castShadow = true; top.receiveShadow = true; scene.add(top)

  // Front panel faces toward the visitor/aisle side
  const panel = new THREE.Mesh(new THREE.BoxGeometry(width, DH * 0.68, 0.04), deskMat)
  panel.position.set(x, DH * 0.34, z + (reversed ? -0.36 : 0.36))
  scene.add(panel)

  // Legs
  const legH = DH - 0.03
  const legGeo = new THREE.BoxGeometry(0.06, legH, 0.06)
  const hw = width / 2 - 0.07
  for (const [dx, dz] of [[-hw, -0.32], [hw, -0.32], [-hw, 0.32], [hw, 0.32]]) {
    const leg = new THREE.Mesh(legGeo, legMat)
    leg.position.set(x + dx, legH / 2, z + dz)
    leg.castShadow = true; scene.add(leg)
  }

  if (!isReception) {
    const monW = 0.50, monH = 0.31
    // Monitor on the "front" side (in front of character)
    const monZ = z + zSign * 0.18
    const mon = new THREE.Mesh(new THREE.BoxGeometry(monW, monH, 0.035), monMat)
    mon.position.set(x, DH + 0.025 + monH / 2 + 0.07, monZ)
    mon.castShadow = true; scene.add(mon)

    // Screen glow faces the character
    const screen = new THREE.Mesh(new THREE.PlaneGeometry(monW - 0.04, monH - 0.04), screenMat)
    screen.position.set(x, DH + 0.025 + monH / 2 + 0.07, monZ + (reversed ? 0.019 : -0.019))
    screen.rotation.y = reversed ? 0 : Math.PI
    scene.add(screen)
    screenMesh = screen

    const stand = new THREE.Mesh(new THREE.CylinderGeometry(0.04, 0.06, 0.12, 8), legMat)
    stand.position.set(x, DH + 0.025 + 0.06, monZ); scene.add(stand)

    const kbMat = new THREE.MeshLambertMaterial({ color: 0x252525 })
    const kb = new THREE.Mesh(new THREE.BoxGeometry(0.36, 0.016, 0.14), kbMat)
    kb.position.set(x, DH + 0.04, z + (reversed ? 0.08 : -0.08)); scene.add(kb)

    const mouse = new THREE.Mesh(new THREE.BoxGeometry(0.07, 0.022, 0.10), kbMat)
    mouse.position.set(x + 0.26, DH + 0.031, z + (reversed ? 0.08 : -0.08)); scene.add(mouse)

  } else {
    // Reception: laptop + decor
    const kbMat = new THREE.MeshLambertMaterial({ color: 0x252525 })
    const laptop = new THREE.Mesh(new THREE.BoxGeometry(0.32, 0.016, 0.22), kbMat)
    laptop.position.set(x - 0.3, DH + 0.04, z); scene.add(laptop)
    const screen = new THREE.Mesh(new THREE.BoxGeometry(0.30, 0.20, 0.015), monMat)
    screen.position.set(x - 0.3, DH + 0.16, z - 0.09)
    screen.rotation.x = -0.35; scene.add(screen)

    const decorMat = new THREE.MeshLambertMaterial({ color: 0x4A7A4A })
    const pot = new THREE.Mesh(new THREE.CylinderGeometry(0.055, 0.042, 0.14, 10), decorMat)
    pot.position.set(x + 0.6, DH + 0.09, z); scene.add(pot)
  }
  return screenMesh
}

function addChair(scene, x, z, reversed) {
  // reversed = chair on -Z side (for Priya who faces +Z)
  const zOff = reversed ? -0.52 : 0.52
  const zBack = reversed ? -0.77 : 0.77

  const seatMat = new THREE.MeshLambertMaterial({ color: 0x2A2420 })  // dark charcoal
  const cushMat = new THREE.MeshLambertMaterial({ color: 0x3A3028 })
  const frameMat = new THREE.MeshLambertMaterial({ color: 0x1A1A18 })

  const seat = new THREE.Mesh(new THREE.BoxGeometry(0.52, 0.06, 0.48), seatMat)
  seat.position.set(x, 0.48, z + zOff); seat.castShadow = true; scene.add(seat)

  const cush = new THREE.Mesh(new THREE.BoxGeometry(0.46, 0.04, 0.42), cushMat)
  cush.position.set(x, 0.53, z + zOff); scene.add(cush)

  const back = new THREE.Mesh(new THREE.BoxGeometry(0.50, 0.52, 0.06), seatMat)
  back.position.set(x, 0.77, z + zBack); back.castShadow = true; scene.add(back)

  const backCush = new THREE.Mesh(new THREE.BoxGeometry(0.44, 0.44, 0.04), cushMat)
  backCush.position.set(x, 0.77, z + zBack + (reversed ? 0.03 : -0.03)); scene.add(backCush)

  const legGeo = new THREE.CylinderGeometry(0.020, 0.020, 0.46, 6)
  const offsets = reversed
    ? [[-0.20, -0.30], [0.20, -0.30], [-0.20, -0.74], [0.20, -0.74]]
    : [[-0.20,  0.30], [0.20,  0.30], [-0.20,  0.74], [0.20,  0.74]]
  for (const [dx, dz] of offsets) {
    const leg = new THREE.Mesh(legGeo, frameMat)
    leg.position.set(x + dx, 0.23, z + dz); scene.add(leg)
  }
}

function addDivider(scene, cx, cz) {
  // Low visual divider between the two desk banks
  const mat = new THREE.MeshLambertMaterial({ color: 0x5A4232 })
  const base = new THREE.Mesh(new THREE.BoxGeometry(6, 0.06, 0.08), mat)
  base.position.set(cx, 1.1, cz); scene.add(base)
  // Small plants on divider
  const potMat = new THREE.MeshLambertMaterial({ color: 0x7A5A3A })
  for (const dx of [-2.0, -0.5, 1.0]) {
    const pot = new THREE.Mesh(new THREE.CylinderGeometry(0.055, 0.042, 0.10, 8), potMat)
    pot.position.set(cx + dx, 1.18, cz); scene.add(pot)
    const leafMat = new THREE.MeshLambertMaterial({ color: dx % 2 === 0 ? 0x2E622E : 0x1E4E1E })
    const leaf = new THREE.Mesh(new THREE.SphereGeometry(0.08, 7, 5), leafMat)
    leaf.position.set(cx + dx, 1.38, cz); scene.add(leaf)
  }
}

function addPainting(scene, x, y, z, wall, style, portrait = false) {
  if (style === 'botanical') portrait = true
  const paintW = portrait ? 1.1  : 2.2
  const paintH = portrait ? 1.55 : 1.35
  const fw = paintW + 0.07, fh = paintH + 0.07

  const texFn = { colorfield: makeColorField, botanical: makeBotanical, geometric: makeGeometric, gestural: makeGestural }
  const tex = (texFn[style] || makeColorField)(paintW, paintH)
  const canvasMat = new THREE.MeshLambertMaterial({ map: tex })
  const sign = wall === 'left' ? 1 : -1

  // Frame behind, canvas in front
  const frameMat = new THREE.MeshLambertMaterial({ color: 0x181818 })
  const frame = new THREE.Mesh(new THREE.BoxGeometry(0.04, fh, fw), frameMat)
  frame.position.set(x, y, z); scene.add(frame)

  const mesh = new THREE.Mesh(new THREE.PlaneGeometry(paintW, paintH), canvasMat)
  mesh.rotation.y = wall === 'left' ? Math.PI / 2 : -Math.PI / 2
  mesh.position.set(x + sign * 0.04, y, z); scene.add(mesh)

  const picGlow = new THREE.PointLight(0xFFF8F0, 0.35, 2.5)
  picGlow.position.set(x + sign * 0.8, y + paintH / 2 + 0.1, z); scene.add(picGlow)
}

function addWallShelf(scene, x, y, z) {
  const shelfMat = new THREE.MeshLambertMaterial({ color: 0x6B4C32 })
  const shelf = new THREE.Mesh(new THREE.BoxGeometry(0.14, 0.03, 0.9), shelfMat)
  shelf.position.set(x + 0.07, y, z)
  scene.add(shelf)

  // Bracket
  const bracketMat = new THREE.MeshLambertMaterial({ color: 0x3A3A3A })
  for (const dz of [-0.3, 0.3]) {
    const bracket = new THREE.Mesh(new THREE.BoxGeometry(0.10, 0.10, 0.02), bracketMat)
    bracket.position.set(x + 0.05, y - 0.06, z + dz)
    scene.add(bracket)
  }

  // Small objects on shelf — books + small pot
  const bookMat1 = new THREE.MeshLambertMaterial({ color: 0x2A4A6A })
  const bookMat2 = new THREE.MeshLambertMaterial({ color: 0x6A2A2A })
  const bookMat3 = new THREE.MeshLambertMaterial({ color: 0x3A5A3A })

  const book1 = new THREE.Mesh(new THREE.BoxGeometry(0.06, 0.16, 0.10), bookMat1)
  book1.position.set(x + 0.10, y + 0.10, z - 0.25); scene.add(book1)
  const book2 = new THREE.Mesh(new THREE.BoxGeometry(0.06, 0.13, 0.10), bookMat2)
  book2.position.set(x + 0.10, y + 0.085, z - 0.14); scene.add(book2)
  const book3 = new THREE.Mesh(new THREE.BoxGeometry(0.06, 0.18, 0.10), bookMat3)
  book3.position.set(x + 0.10, y + 0.11, z - 0.03); scene.add(book3)

  // Small decorative pot
  const potMat = new THREE.MeshLambertMaterial({ color: 0xD4C4A8 })
  const pot = new THREE.Mesh(new THREE.CylinderGeometry(0.04, 0.03, 0.08, 8), potMat)
  pot.position.set(x + 0.10, y + 0.055, z + 0.20); scene.add(pot)
  const miniLeaf = new THREE.Mesh(new THREE.SphereGeometry(0.04, 6, 4),
    new THREE.MeshLambertMaterial({ color: 0x2A5A28 }))
  miniLeaf.position.set(x + 0.10, y + 0.13, z + 0.20); scene.add(miniLeaf)
}

function addCoffeeStation(scene, x, z) {
  const cabinetMat = new THREE.MeshLambertMaterial({ color: 0x5A4030 })
  const topMat     = new THREE.MeshLambertMaterial({ color: 0x8A7A68 })
  const metalMat   = new THREE.MeshLambertMaterial({ color: 0x4A4A4A })
  const mugMat1    = new THREE.MeshLambertMaterial({ color: 0xF0EAE0 })
  const mugMat2    = new THREE.MeshLambertMaterial({ color: 0x2A4A6A })

  // Cabinet
  const cabinet = new THREE.Mesh(new THREE.BoxGeometry(1.2, 0.85, 0.45), cabinetMat)
  cabinet.position.set(x, 0.425, z); scene.add(cabinet)

  // Countertop
  const top = new THREE.Mesh(new THREE.BoxGeometry(1.3, 0.04, 0.50), topMat)
  top.position.set(x, 0.87, z); scene.add(top)

  // Coffee machine
  const machine = new THREE.Mesh(new THREE.BoxGeometry(0.22, 0.32, 0.20), metalMat)
  machine.position.set(x - 0.3, 1.05, z); scene.add(machine)
  const spout = new THREE.Mesh(new THREE.CylinderGeometry(0.015, 0.015, 0.06, 6), metalMat)
  spout.position.set(x - 0.3, 0.91, z + 0.06); scene.add(spout)

  // Mugs
  for (let i = 0; i < 3; i++) {
    const mat = i === 1 ? mugMat2 : mugMat1
    const mug = new THREE.Mesh(new THREE.CylinderGeometry(0.03, 0.025, 0.07, 8), mat)
    mug.position.set(x + 0.1 + i * 0.10, 0.925, z + 0.05); scene.add(mug)
    // Handle
    const handle = new THREE.Mesh(new THREE.TorusGeometry(0.018, 0.005, 6, 8, Math.PI),
      new THREE.MeshLambertMaterial({ color: mat.color }))
    handle.rotation.y = Math.PI / 2
    handle.position.set(x + 0.1 + i * 0.10, 0.925, z + 0.08); scene.add(handle)
  }

  // Small tray
  const tray = new THREE.Mesh(new THREE.BoxGeometry(0.30, 0.015, 0.18),
    new THREE.MeshLambertMaterial({ color: 0x3A3A3A }))
  tray.position.set(x + 0.2, 0.895, z + 0.05); scene.add(tray)
}

function addWallClock(scene, x, y, z) {
  const frameMat = new THREE.MeshLambertMaterial({ color: 0x2A2A2A })
  const faceMat  = new THREE.MeshLambertMaterial({ color: 0xF5F2EC })
  const handMat  = new THREE.MeshLambertMaterial({ color: 0x1A1A1A })

  // Frame ring
  const frame = new THREE.Mesh(new THREE.TorusGeometry(0.22, 0.02, 12, 32), frameMat)
  frame.rotation.y = Math.PI / 2
  frame.position.set(x, y, z); scene.add(frame)

  // Face
  const face = new THREE.Mesh(new THREE.CircleGeometry(0.21, 24), faceMat)
  face.rotation.y = Math.PI / 2
  face.position.set(x + 0.01, y, z); scene.add(face)

  // Hour markers
  for (let i = 0; i < 12; i++) {
    const angle = (i / 12) * Math.PI * 2
    const marker = new THREE.Mesh(new THREE.BoxGeometry(0.008, 0.03, 0.008), handMat)
    marker.position.set(x + 0.015, y + Math.cos(angle) * 0.17, z + Math.sin(angle) * 0.17)
    scene.add(marker)
  }

  // Hour hand (static — ~10:10 position)
  const hourHand = new THREE.Mesh(new THREE.BoxGeometry(0.008, 0.10, 0.015), handMat)
  hourHand.rotation.x = -0.85
  hourHand.position.set(x + 0.015, y + 0.04, z - 0.02); scene.add(hourHand)

  // Minute hand
  const minHand = new THREE.Mesh(new THREE.BoxGeometry(0.006, 0.14, 0.012), handMat)
  minHand.rotation.x = 0.85
  minHand.position.set(x + 0.015, y + 0.02, z + 0.05); scene.add(minHand)

  // Center dot
  const dot = new THREE.Mesh(new THREE.SphereGeometry(0.012, 8, 6), handMat)
  dot.position.set(x + 0.015, y, z); scene.add(dot)
}

function addEndWallPaintingReversed(scene, x, y, z, style) {
  const paintW = 2.2, paintH = 1.6
  const fw = paintW + 0.08, fh = paintH + 0.08

  const texFn = { colorfield: makeColorField, geometric: makeGeometric, gestural: makeGestural, botanical: makeBotanical }
  const tex = (texFn[style] || makeColorField)(paintW, paintH)
  const canvasMat = new THREE.MeshLambertMaterial({ map: tex })

  const frameMat = new THREE.MeshLambertMaterial({ color: 0x181818 })
  const frame = new THREE.Mesh(new THREE.BoxGeometry(fw, fh, 0.04), frameMat)
  frame.position.set(x, y, z); scene.add(frame)

  const mesh = new THREE.Mesh(new THREE.PlaneGeometry(paintW, paintH), canvasMat)
  mesh.rotation.y = Math.PI
  mesh.position.set(x, y, z - 0.03); scene.add(mesh)

  const picGlow = new THREE.PointLight(0xFFF8F0, 0.5, 3)
  picGlow.position.set(x, y + paintH / 2 + 0.3, z - 1); scene.add(picGlow)
}

function addEndWallPainting(scene, x, y, z, style) {
  const paintW = 2.2, paintH = 1.6
  const fw = paintW + 0.08, fh = paintH + 0.08

  const texFn = { colorfield: makeColorField, geometric: makeGeometric, gestural: makeGestural, botanical: makeBotanical }
  const tex = (texFn[style] || makeColorField)(paintW, paintH)
  const canvasMat = new THREE.MeshLambertMaterial({ map: tex })

  const frameMat = new THREE.MeshLambertMaterial({ color: 0x181818 })
  const frame = new THREE.Mesh(new THREE.BoxGeometry(fw, fh, 0.04), frameMat)
  frame.position.set(x, y, z); scene.add(frame)

  const mesh = new THREE.Mesh(new THREE.PlaneGeometry(paintW, paintH), canvasMat)
  mesh.position.set(x, y, z + 0.03); scene.add(mesh)

  const picGlow = new THREE.PointLight(0xFFF8F0, 0.5, 3)
  picGlow.position.set(x, y + paintH / 2 + 0.3, z + 1); scene.add(picGlow)
}

function addFarWallPainting(scene, x, y, z, style) {
  const paintW = 2.8, paintH = 1.8
  const fw = paintW + 0.09, fh = paintH + 0.09

  const texFn = { colorfield: makeColorField, geometric: makeGeometric, gestural: makeGestural }
  const tex = (texFn[style] || makeColorField)(paintW, paintH)
  const canvasMat = new THREE.MeshLambertMaterial({ map: tex })

  const frameMat = new THREE.MeshLambertMaterial({ color: 0x181818 })
  const frame = new THREE.Mesh(new THREE.BoxGeometry(0.04, fh, fw), frameMat)
  frame.position.set(x, y, z); scene.add(frame)

  const mesh = new THREE.Mesh(new THREE.PlaneGeometry(paintW, paintH), canvasMat)
  mesh.rotation.y = -Math.PI / 2  // faces -X toward the glass
  mesh.position.set(x - 0.04, y, z); scene.add(mesh)

  const picGlow = new THREE.PointLight(0xFFF8F0, 0.8, 4)
  picGlow.position.set(x - 1.2, y + 0.3, z); scene.add(picGlow)
}

function _paintCanvas(w, h, res = 512) {
  const px = res, py = Math.round(res * h / w)
  const canvas = document.createElement('canvas')
  canvas.width = px; canvas.height = py
  return { canvas, ctx: canvas.getContext('2d'), px, py }
}

// Bold color block — two large fields separated by a thin gap, very readable at distance
function makeColorField(w, h) {
  const { canvas, ctx, px, py } = _paintCanvas(w, h)
  const palettes = [
    ['#C8503A', '#1E3A5A'],   // terracotta + navy
    ['#3A5A3A', '#D4B870'],   // deep green + warm gold
    ['#5A3050', '#E8D0B0'],   // plum + cream
    ['#1A2840', '#B06040'],   // midnight + burnt sienna
  ]
  const [a, b] = palettes[Math.floor(Math.random() * palettes.length)]
  // Top block
  ctx.fillStyle = a; ctx.fillRect(0, 0, px, py * 0.48)
  // Thin white gap
  ctx.fillStyle = '#F5F4F2'; ctx.fillRect(0, py * 0.48, px, py * 0.04)
  // Bottom block
  ctx.fillStyle = b; ctx.fillRect(0, py * 0.52, px, py * 0.48)
  // Soft inner glow on top block
  const glow = ctx.createRadialGradient(px*0.5, py*0.24, 0, px*0.5, py*0.24, px*0.5)
  glow.addColorStop(0, 'rgba(255,255,255,0.08)'); glow.addColorStop(1, 'rgba(0,0,0,0)')
  ctx.fillStyle = glow; ctx.fillRect(0, 0, px, py)
  return new THREE.CanvasTexture(canvas)
}

// Large botanical — bold single plant silhouette, filled dark on cream
function makeBotanical(w, h) {
  const { canvas, ctx, px, py } = _paintCanvas(w, h, 400)
  ctx.fillStyle = '#F0EDE6'; ctx.fillRect(0, 0, px, py)

  ctx.fillStyle = '#1C1A16'; ctx.strokeStyle = '#1C1A16'
  ctx.lineCap = 'round'; ctx.lineJoin = 'round'

  // Thick central stem
  ctx.lineWidth = px * 0.025
  ctx.beginPath(); ctx.moveTo(px*0.5, py*0.98)
  ctx.bezierCurveTo(px*0.48, py*0.7, px*0.53, py*0.45, px*0.5, py*0.08)
  ctx.stroke()

  // Large filled leaves
  const leafDefs = [
    { x: 0.5, y: 0.78, angle: -1.1, lw: 0.22, lh: 0.35 },
    { x: 0.5, y: 0.78, angle:  1.1, lw: 0.22, lh: 0.35 },
    { x: 0.5, y: 0.55, angle: -1.3, lw: 0.20, lh: 0.32 },
    { x: 0.5, y: 0.55, angle:  1.3, lw: 0.20, lh: 0.32 },
    { x: 0.5, y: 0.35, angle: -1.2, lw: 0.16, lh: 0.26 },
    { x: 0.5, y: 0.35, angle:  1.2, lw: 0.16, lh: 0.26 },
    { x: 0.5, y: 0.18, angle:  0,   lw: 0.14, lh: 0.22 },
  ]
  for (const { x, y, angle, lw, lh } of leafDefs) {
    ctx.save(); ctx.translate(px*x, py*y); ctx.rotate(angle)
    const W = px*lw, H = py*lh
    ctx.beginPath()
    ctx.moveTo(0, 0)
    ctx.bezierCurveTo(W*0.6, -H*0.15, W*0.8, H*0.4, 0, H)
    ctx.bezierCurveTo(-W*0.3, H*0.4, -W*0.2, -H*0.1, 0, 0)
    ctx.fill()
    // vein — white line on dark fill
    ctx.strokeStyle = '#F0EDE6'; ctx.lineWidth = px*0.008
    ctx.beginPath(); ctx.moveTo(0, H*0.05); ctx.lineTo(0, H*0.88); ctx.stroke()
    ctx.strokeStyle = '#1C1A16'
    ctx.restore()
  }
  return new THREE.CanvasTexture(canvas)
}

// Bold geometric — Bauhaus-influenced, strong shapes, limited palette
function makeGeometric(w, h) {
  const { canvas, ctx, px, py } = _paintCanvas(w, h)
  ctx.fillStyle = '#F5F3EF'; ctx.fillRect(0, 0, px, py)

  // Large circle — dominant element
  ctx.fillStyle = '#2A3850'
  ctx.beginPath(); ctx.arc(px*0.62, py*0.46, py*0.36, 0, Math.PI*2); ctx.fill()

  // Overlapping rectangle — terracotta
  ctx.fillStyle = '#C05838'
  ctx.fillRect(px*0.04, py*0.15, px*0.45, py*0.55)

  // Small accent square — warm gold
  ctx.fillStyle = '#D4A840'
  ctx.fillRect(px*0.62, py*0.72, px*0.28, py*0.22)

  // Thin horizontal rule
  ctx.fillStyle = '#1A1A1A'
  ctx.fillRect(0, py*0.885, px, py*0.012)

  // Vertical rule
  ctx.fillRect(px*0.82, 0, px*0.010, py*0.885)

  return new THREE.CanvasTexture(canvas)
}

// Abstract gestural — bold thick strokes, reads at distance
function makeGestural(w, h) {
  const { canvas, ctx, px, py } = _paintCanvas(w, h)
  ctx.fillStyle = '#EEEAE4'; ctx.fillRect(0, 0, px, py)

  ctx.lineCap = 'round'; ctx.lineJoin = 'round'

  // 3 large dominant strokes
  const strokes = [
    { color: '#B04828', pts: [[0.05,0.75],[0.3,0.35],[0.6,0.55],[0.88,0.18]], lw: py*0.10 },
    { color: '#243858', pts: [[0.12,0.15],[0.4,0.5],[0.7,0.3],[0.95,0.7]],  lw: py*0.09 },
    { color: '#4A7050', pts: [[0.0,0.5],[0.35,0.65],[0.55,0.4],[0.85,0.85]], lw: py*0.07 },
  ]
  for (const s of strokes) {
    ctx.strokeStyle = s.color; ctx.lineWidth = s.lw; ctx.globalAlpha = 0.82
    ctx.beginPath(); ctx.moveTo(s.pts[0][0]*px, s.pts[0][1]*py)
    for (let i = 1; i < s.pts.length; i++) {
      const p = s.pts[i-1], c = s.pts[i]
      ctx.quadraticCurveTo(p[0]*px, p[1]*py, (p[0]+c[0])/2*px, (p[1]+c[1])/2*py)
    }
    ctx.stroke()
  }
  ctx.globalAlpha = 1

  // Fine dark mark overlay — energy
  ctx.strokeStyle = '#1A1410'; ctx.lineWidth = px*0.004; ctx.globalAlpha = 0.35
  for (const [x1,y1,x2,y2] of [[0.1,0.2,0.5,0.1],[0.6,0.8,0.9,0.6],[0.3,0.9,0.7,0.75]]) {
    ctx.beginPath(); ctx.moveTo(x1*px,y1*py); ctx.lineTo(x2*px,y2*py); ctx.stroke()
  }
  ctx.globalAlpha = 1

  return new THREE.CanvasTexture(canvas)
}

// ── Legacy (unused but kept to avoid reference errors) ─────────────────────
function makeLandscapePainting(w, h) {
  const px = 512, py = Math.round(512 * h / w)
  const canvas = document.createElement('canvas')
  canvas.width = px; canvas.height = py
  const ctx = canvas.getContext('2d')

  // Sky gradient
  const sky = ctx.createLinearGradient(0, 0, 0, py * 0.55)
  sky.addColorStop(0,   '#E8D5B0')
  sky.addColorStop(0.5, '#C8A870')
  sky.addColorStop(1,   '#A87848')
  ctx.fillStyle = sky; ctx.fillRect(0, 0, px, py)

  // Horizon hills
  ctx.fillStyle = '#7A6040'
  ctx.beginPath(); ctx.moveTo(0, py * 0.55)
  for (let i = 0; i <= px; i += 20) {
    ctx.lineTo(i, py * 0.55 - Math.sin(i / 60) * 15 - Math.sin(i / 23) * 8)
  }
  ctx.lineTo(px, py); ctx.lineTo(0, py); ctx.fill()

  // Foreground
  const fg = ctx.createLinearGradient(0, py * 0.65, 0, py)
  fg.addColorStop(0, '#5A4830'); fg.addColorStop(1, '#3A2E18')
  ctx.fillStyle = fg; ctx.fillRect(0, py * 0.65, px, py)

  // Tree silhouettes
  ctx.fillStyle = '#2E2416'
  for (let i = 0; i < 6; i++) {
    const tx = 60 + i * 70 + (Math.random() - 0.5) * 30
    const th = 80 + Math.random() * 60
    ctx.beginPath()
    ctx.moveTo(tx, py * 0.65)
    ctx.lineTo(tx - 12, py * 0.65 - th * 0.6)
    ctx.lineTo(tx, py * 0.65 - th)
    ctx.lineTo(tx + 12, py * 0.65 - th * 0.6)
    ctx.fill()
  }

  // Sun glow
  const glow = ctx.createRadialGradient(px * 0.7, py * 0.2, 0, px * 0.7, py * 0.2, 80)
  glow.addColorStop(0, 'rgba(255,220,140,0.7)')
  glow.addColorStop(1, 'rgba(255,200,80,0)')
  ctx.fillStyle = glow; ctx.fillRect(0, 0, px, py)

  const tex = new THREE.CanvasTexture(canvas)
  return tex
}

function makeAbstractPainting(w, h) {
  const px = 400, py = Math.round(400 * h / w)
  const canvas = document.createElement('canvas')
  canvas.width = px; canvas.height = py
  const ctx = canvas.getContext('2d')

  ctx.fillStyle = '#F0E8DC'; ctx.fillRect(0, 0, px, py)

  // Bold color blocks
  const colors = ['#C4704A', '#8B4A2A', '#D4A060', '#6B8A5A', '#3A5A4A', '#E8C890', '#A06840']
  const rects = [
    [0,       0,       px * 0.4, py * 0.6],
    [px * 0.4, 0,      px * 0.6, py * 0.35],
    [px * 0.55, py*0.35, px*0.45, py*0.4],
    [px * 0.4, py*0.75, px*0.6, py*0.25],
    [0,       py*0.6,  px*0.35, py*0.4],
    [px*0.35, py*0.55, px*0.2, py*0.45],
  ]
  rects.forEach(([rx, ry, rw, rh], i) => {
    ctx.fillStyle = colors[i % colors.length]
    ctx.fillRect(rx, ry, rw, rh)
  })

  // Thin dividing lines
  ctx.strokeStyle = '#2A1E14'
  ctx.lineWidth = 3
  ctx.strokeRect(0, 0, px, py)
  ctx.beginPath()
  ctx.moveTo(px * 0.4, 0); ctx.lineTo(px * 0.4, py)
  ctx.moveTo(0, py * 0.6); ctx.lineTo(px * 0.4, py * 0.6)
  ctx.moveTo(px * 0.4, py * 0.35); ctx.lineTo(px, py * 0.35)
  ctx.moveTo(px * 0.55, py * 0.35); ctx.lineTo(px * 0.55, py)
  ctx.moveTo(px * 0.35, py * 0.55); ctx.lineTo(px * 0.55, py * 0.55)
  ctx.stroke()

  const tex = new THREE.CanvasTexture(canvas)
  return tex
}

// ── Abstract wall art textures ────────────────────────────────────────────

function makeRenaissancePortrait(w, h) {
  const px = 400, py = Math.round(400 * h / w)
  const canvas = document.createElement('canvas')
  canvas.width = px; canvas.height = py
  const ctx = canvas.getContext('2d')

  // Dark background — Rembrandt-style
  ctx.fillStyle = '#1A1208'; ctx.fillRect(0, 0, px, py)
  const bgGrad = ctx.createRadialGradient(px * 0.5, py * 0.38, 10, px * 0.5, py * 0.38, px * 0.55)
  bgGrad.addColorStop(0, 'rgba(60,40,15,0.7)'); bgGrad.addColorStop(1, 'rgba(10,6,2,0)')
  ctx.fillStyle = bgGrad; ctx.fillRect(0, 0, px, py)

  // Shoulders / clothing — dark doublet
  ctx.fillStyle = '#1E1810'
  ctx.beginPath()
  ctx.ellipse(px * 0.5, py * 0.88, px * 0.38, py * 0.3, 0, 0, Math.PI * 2)
  ctx.fill()
  // White collar
  ctx.fillStyle = '#E8E0D0'
  ctx.beginPath()
  ctx.ellipse(px * 0.5, py * 0.62, px * 0.18, py * 0.07, 0, 0, Math.PI * 2)
  ctx.fill()
  ctx.fillStyle = '#F0E8DC'
  ctx.beginPath(); ctx.moveTo(px * 0.34, py * 0.62)
  ctx.bezierCurveTo(px * 0.38, py * 0.56, px * 0.44, py * 0.54, px * 0.5, py * 0.56)
  ctx.bezierCurveTo(px * 0.56, py * 0.54, px * 0.62, py * 0.56, px * 0.66, py * 0.62)
  ctx.lineTo(px * 0.5, py * 0.68); ctx.closePath(); ctx.fill()

  // Face — warm skin, side-lit
  const faceGrad = ctx.createRadialGradient(px * 0.44, py * 0.38, 4, px * 0.5, py * 0.38, px * 0.2)
  faceGrad.addColorStop(0, '#D4905A'); faceGrad.addColorStop(0.6, '#B87040'); faceGrad.addColorStop(1, '#603010')
  ctx.fillStyle = faceGrad
  ctx.beginPath()
  ctx.ellipse(px * 0.5, py * 0.38, px * 0.18, py * 0.22, 0, 0, Math.PI * 2)
  ctx.fill()

  // Eyes
  ctx.fillStyle = '#1A0E06'
  ctx.beginPath(); ctx.ellipse(px * 0.43, py * 0.35, 5, 3.5, 0, 0, Math.PI * 2); ctx.fill()
  ctx.beginPath(); ctx.ellipse(px * 0.57, py * 0.35, 5, 3.5, 0, 0, Math.PI * 2); ctx.fill()
  ctx.fillStyle = 'rgba(255,220,180,0.5)'
  ctx.beginPath(); ctx.arc(px * 0.44, py * 0.348, 2, 0, Math.PI * 2); ctx.fill()
  ctx.beginPath(); ctx.arc(px * 0.58, py * 0.348, 2, 0, Math.PI * 2); ctx.fill()

  // Nose shadow
  ctx.fillStyle = 'rgba(80,35,10,0.4)'
  ctx.beginPath(); ctx.ellipse(px * 0.51, py * 0.42, 4, 5, 0, 0, Math.PI * 2); ctx.fill()

  // Hair — dark, loosely indicated
  ctx.fillStyle = '#1C1008'
  ctx.beginPath()
  ctx.ellipse(px * 0.5, py * 0.2, px * 0.2, py * 0.12, 0, 0, Math.PI * 2)
  ctx.fill()
  ctx.beginPath()
  ctx.ellipse(px * 0.5, py * 0.16, px * 0.16, py * 0.1, 0, 0, Math.PI * 2)
  ctx.fill()

  // Varnish — warm golden glaze
  const glaze = ctx.createLinearGradient(0, 0, px, py)
  glaze.addColorStop(0, 'rgba(80,50,10,0.12)'); glaze.addColorStop(1, 'rgba(40,20,0,0.18)')
  ctx.fillStyle = glaze; ctx.fillRect(0, 0, px, py)

  return new THREE.CanvasTexture(canvas)
}

function makeMadonna(w, h) {
  const px = 400, py = Math.round(400 * h / w)
  const canvas = document.createElement('canvas')
  canvas.width = px; canvas.height = py
  const ctx = canvas.getContext('2d')

  // Gold / ochre ground — egg tempera feel
  const bg = ctx.createLinearGradient(0, 0, 0, py)
  bg.addColorStop(0, '#C89840'); bg.addColorStop(0.5, '#D4A850'); bg.addColorStop(1, '#A87828')
  ctx.fillStyle = bg; ctx.fillRect(0, 0, px, py)

  // Gold leaf texture — subtle hatching
  ctx.strokeStyle = 'rgba(180,130,30,0.25)'; ctx.lineWidth = 0.8
  for (let i = 0; i < py; i += 6) {
    ctx.beginPath(); ctx.moveTo(0, i); ctx.lineTo(px, i + 4); ctx.stroke()
  }

  // Arch / mandorla behind figure
  const archGrad = ctx.createRadialGradient(px * 0.5, py * 0.45, 20, px * 0.5, py * 0.45, px * 0.42)
  archGrad.addColorStop(0, 'rgba(255,240,160,0.55)'); archGrad.addColorStop(1, 'rgba(200,160,40,0)')
  ctx.fillStyle = archGrad; ctx.fillRect(0, 0, px, py)

  // Madonna's robe — deep ultramarine blue
  ctx.fillStyle = '#1A2C6A'
  ctx.beginPath()
  ctx.moveTo(px * 0.18, py)
  ctx.bezierCurveTo(px * 0.1, py * 0.7, px * 0.22, py * 0.45, px * 0.36, py * 0.38)
  ctx.bezierCurveTo(px * 0.44, py * 0.35, px * 0.5, py * 0.36, px * 0.56, py * 0.38)
  ctx.bezierCurveTo(px * 0.72, py * 0.44, px * 0.88, py * 0.68, px * 0.82, py)
  ctx.closePath(); ctx.fill()
  // Robe fold highlights
  ctx.strokeStyle = '#2A4A9A'; ctx.lineWidth = 2
  for (const [x1, y1, x2, y2] of [
    [px*0.3, py*0.5, px*0.28, py*0.85], [px*0.5, py*0.42, px*0.48, py*0.9],
    [px*0.65, py*0.52, px*0.67, py*0.8]
  ]) {
    ctx.beginPath(); ctx.moveTo(x1, y1); ctx.lineTo(x2, y2); ctx.stroke()
  }

  // Red under-dress
  ctx.fillStyle = '#8A2010'
  ctx.beginPath()
  ctx.ellipse(px * 0.5, py * 0.55, px * 0.12, py * 0.08, 0, 0, Math.PI * 2)
  ctx.fill()

  // Face
  const faceGrad = ctx.createRadialGradient(px * 0.48, py * 0.26, 3, px * 0.5, py * 0.27, px * 0.16)
  faceGrad.addColorStop(0, '#E8C090'); faceGrad.addColorStop(0.7, '#C89060'); faceGrad.addColorStop(1, '#805030')
  ctx.fillStyle = faceGrad
  ctx.beginPath(); ctx.ellipse(px * 0.5, py * 0.27, px * 0.13, py * 0.17, 0, 0, Math.PI * 2); ctx.fill()

  // Gold halo
  ctx.strokeStyle = '#E8C030'; ctx.lineWidth = 3
  ctx.beginPath(); ctx.arc(px * 0.5, py * 0.24, px * 0.19, 0, Math.PI * 2); ctx.stroke()
  ctx.strokeStyle = 'rgba(232,192,48,0.4)'; ctx.lineWidth = 7
  ctx.beginPath(); ctx.arc(px * 0.5, py * 0.24, px * 0.19, 0, Math.PI * 2); ctx.stroke()

  // Eyes, nose
  ctx.fillStyle = '#2A1808'
  ctx.beginPath(); ctx.ellipse(px * 0.44, py * 0.265, 4, 2.5, 0, 0, Math.PI * 2); ctx.fill()
  ctx.beginPath(); ctx.ellipse(px * 0.56, py * 0.265, 4, 2.5, 0, 0, Math.PI * 2); ctx.fill()
  ctx.fillStyle = 'rgba(70,28,8,0.35)'
  ctx.beginPath(); ctx.arc(px * 0.5, py * 0.3, 3, 0, Math.PI * 2); ctx.fill()

  // Veil / headdress
  ctx.fillStyle = 'rgba(200,180,140,0.6)'
  ctx.beginPath()
  ctx.ellipse(px * 0.5, py * 0.18, px * 0.16, py * 0.1, 0, 0, Math.PI * 2)
  ctx.fill()

  // Child figure (small, lower center)
  ctx.fillStyle = '#D49060'
  ctx.beginPath(); ctx.ellipse(px * 0.5, py * 0.52, px * 0.07, py * 0.09, 0, 0, Math.PI * 2); ctx.fill()
  ctx.fillStyle = '#E8B870'
  ctx.beginPath(); ctx.arc(px * 0.5, py * 0.44, px * 0.055, 0, Math.PI * 2); ctx.fill()
  ctx.strokeStyle = '#C89040'; ctx.lineWidth = 2
  ctx.beginPath(); ctx.arc(px * 0.5, py * 0.42, px * 0.075, 0, Math.PI * 2); ctx.stroke()

  // Crackle/varnish
  const varnish = ctx.createLinearGradient(0, 0, px, py)
  varnish.addColorStop(0, 'rgba(60,35,5,0.1)'); varnish.addColorStop(1, 'rgba(80,50,0,0.15)')
  ctx.fillStyle = varnish; ctx.fillRect(0, 0, px, py)

  return new THREE.CanvasTexture(canvas)
}

function makeRenaissanceScene(w, h) {
  const px = 512, py = Math.round(512 * h / w)
  const canvas = document.createElement('canvas')
  canvas.width = px; canvas.height = py
  const ctx = canvas.getContext('2d')

  // Sky — hazy Italian blue
  const sky = ctx.createLinearGradient(0, 0, 0, py * 0.55)
  sky.addColorStop(0, '#6888B0'); sky.addColorStop(1, '#B8CCDC')
  ctx.fillStyle = sky; ctx.fillRect(0, 0, px, py)

  // Distant hills — sfumato haze
  for (let i = 3; i >= 0; i--) {
    const yBase = py * (0.38 + i * 0.06)
    const col = `rgba(${60+i*25},${80+i*20},${50+i*15},${0.5 - i * 0.08})`
    ctx.fillStyle = col
    ctx.beginPath(); ctx.moveTo(0, py)
    for (let x = 0; x <= px; x += 12) {
      ctx.lineTo(x, yBase - Math.sin(x / 55 + i) * 18 - Math.sin(x / 22) * 8)
    }
    ctx.lineTo(px, py); ctx.fill()
  }

  // Architectural columns left side
  ctx.fillStyle = '#C8B890'
  for (const cx of [px * 0.04, px * 0.14]) {
    ctx.fillRect(cx - 8, py * 0.15, 16, py * 0.85)
    ctx.fillStyle = '#E0D0A8'
    ctx.beginPath(); ctx.ellipse(cx, py * 0.15, 14, 8, 0, 0, Math.PI * 2); ctx.fill()
    ctx.fillStyle = '#C8B890'
  }
  // Architrave
  ctx.fillStyle = '#B8A878'
  ctx.fillRect(0, py * 0.13, px * 0.22, py * 0.04)

  // Ground — warm sienna earth
  const ground = ctx.createLinearGradient(0, py * 0.72, 0, py)
  ground.addColorStop(0, '#8A6030'); ground.addColorStop(1, '#5A3810')
  ctx.fillStyle = ground; ctx.fillRect(0, py * 0.72, px, py * 0.28)

  // Path / road
  ctx.fillStyle = '#B89060'
  ctx.beginPath()
  ctx.moveTo(px * 0.35, py); ctx.lineTo(px * 0.65, py)
  ctx.lineTo(px * 0.56, py * 0.72); ctx.lineTo(px * 0.44, py * 0.72)
  ctx.closePath(); ctx.fill()

  // Cypress trees right side
  ctx.fillStyle = '#1E3818'
  for (const [tx, th] of [[px * 0.78, py * 0.42], [px * 0.88, py * 0.36], [px * 0.94, py * 0.46]]) {
    ctx.beginPath()
    ctx.moveTo(tx, py * 0.72)
    ctx.bezierCurveTo(tx - 10, py * 0.72 - th * 0.4, tx - 6, py * 0.72 - th * 0.7, tx, py * 0.72 - th)
    ctx.bezierCurveTo(tx + 6, py * 0.72 - th * 0.7, tx + 10, py * 0.72 - th * 0.4, tx, py * 0.72)
    ctx.fill()
  }

  // Foreground figures (dark silhouettes, draped)
  ctx.fillStyle = '#2A1C10'
  // Figure 1
  ctx.beginPath(); ctx.ellipse(px * 0.3, py * 0.62, 9, 12, -0.15, 0, Math.PI * 2); ctx.fill()
  ctx.beginPath(); ctx.arc(px * 0.31, py * 0.51, 8, 0, Math.PI * 2); ctx.fill()
  // Figure 2
  ctx.beginPath(); ctx.ellipse(px * 0.42, py * 0.65, 8, 11, 0.1, 0, Math.PI * 2); ctx.fill()
  ctx.beginPath(); ctx.arc(px * 0.41, py * 0.54, 7, 0, Math.PI * 2); ctx.fill()

  // Golden varnish glaze
  const varnish = ctx.createLinearGradient(0, 0, px, py)
  varnish.addColorStop(0, 'rgba(80,55,10,0.12)'); varnish.addColorStop(1, 'rgba(50,30,5,0.18)')
  ctx.fillStyle = varnish; ctx.fillRect(0, 0, px, py)

  return new THREE.CanvasTexture(canvas)
}

function addWhiteboard(scene, x, y, z) {
  const frameMat = new THREE.MeshLambertMaterial({ color: 0x8A7A68 })
  const boardMat = new THREE.MeshLambertMaterial({ color: 0xFAF8F2, emissive: 0x080806, emissiveIntensity: 0.05 })
  const w = 2.2, h = 1.3

  const frame = new THREE.Mesh(new THREE.BoxGeometry(w + 0.1, h + 0.1, 0.04), frameMat)
  frame.position.set(x, y, z); frame.rotation.y = Math.PI / 2; scene.add(frame)

  const board = new THREE.Mesh(new THREE.PlaneGeometry(w, h), boardMat)
  board.position.set(x + 0.03, y, z); board.rotation.y = Math.PI / 2; scene.add(board)

  const lineMat = new THREE.LineBasicMaterial({ color: 0x334455, opacity: 0.25, transparent: true })
  for (let i = 0; i < 4; i++) {
    const pts = [
      new THREE.Vector3(x + 0.05, y + 0.3 - i * 0.25, z - 0.7 + Math.random() * 0.15),
      new THREE.Vector3(x + 0.05, y + 0.3 - i * 0.25, z + 0.5 + Math.random() * 0.15)
    ]
    scene.add(new THREE.Line(new THREE.BufferGeometry().setFromPoints(pts), lineMat))
  }
}

function addBookshelf(scene, x, z) {
  const woodMat = new THREE.MeshLambertMaterial({ color: 0x4A3220 })
  const shelfH = 0.22, shelfW = 0.9, totalH = 2.2

  const back = new THREE.Mesh(new THREE.BoxGeometry(0.04, totalH, shelfW), woodMat)
  back.position.set(x, totalH / 2, z); back.rotation.y = Math.PI / 2; scene.add(back)

  const bookColors = [0x6B2020, 0x1A3A5A, 0x205A20, 0x5A5A10, 0x3A1A5A, 0x5A2A10]
  for (let i = 0; i <= 4; i++) {
    const shelf = new THREE.Mesh(new THREE.BoxGeometry(0.04, 0.03, shelfW), woodMat)
    shelf.position.set(x, i * shelfH + 0.02, z); shelf.rotation.y = Math.PI / 2; scene.add(shelf)
    if (i < 4) {
      let bz = z - shelfW / 2 + 0.05
      while (bz < z + shelfW / 2 - 0.05) {
        const bw = 0.03 + Math.random() * 0.025
        const bh = shelfH * (0.7 + Math.random() * 0.25)
        const book = new THREE.Mesh(
          new THREE.BoxGeometry(0.04, bh, bw),
          new THREE.MeshLambertMaterial({ color: bookColors[Math.floor(Math.random() * bookColors.length)] })
        )
        book.position.set(x, i * shelfH + bh / 2 + 0.03, bz + bw / 2)
        book.rotation.y = Math.PI / 2; scene.add(book)
        bz += bw + 0.006
      }
    }
  }
  for (const dz of [-shelfW / 2, shelfW / 2]) {
    const side = new THREE.Mesh(new THREE.BoxGeometry(0.04, totalH, 0.03), woodMat)
    side.position.set(x, totalH / 2, z + dz); side.rotation.y = Math.PI / 2; scene.add(side)
  }
}

function addPlant(scene, x, z, scale = 1) {
  const potMat  = new THREE.MeshLambertMaterial({ color: 0x8A6040 })
  const soilMat = new THREE.MeshLambertMaterial({ color: 0x2E1E0C })
  const leaf1   = new THREE.MeshLambertMaterial({ color: 0x285A28 })
  const leaf2   = new THREE.MeshLambertMaterial({ color: 0x1A4018 })

  const pot = new THREE.Mesh(new THREE.CylinderGeometry(0.13 * scale, 0.10 * scale, 0.24 * scale, 12), potMat)
  pot.position.set(x, 0.12 * scale, z); pot.castShadow = true; scene.add(pot)
  const soil = new THREE.Mesh(new THREE.CylinderGeometry(0.12 * scale, 0.12 * scale, 0.02, 12), soilMat)
  soil.position.set(x, 0.24 * scale, z); scene.add(soil)

  const offsets = [
    [0, 0.55, 0, 0.20, leaf1], [-0.12, 0.46, 0.05, 0.15, leaf2],
    [0.12, 0.46, -0.04, 0.15, leaf1], [0.04, 0.38, 0.1, 0.12, leaf2],
    [-0.04, 0.64, 0.02, 0.13, leaf1], [0.08, 0.52, -0.08, 0.11, leaf2],
  ]
  for (const [ox, oy, oz, r, mat] of offsets) {
    const leaf = new THREE.Mesh(new THREE.SphereGeometry(r * scale, 8, 6), mat)
    leaf.position.set(x + ox * scale, oy * scale, z + oz * scale)
    leaf.scale.y = 1.15; leaf.castShadow = true; scene.add(leaf)
  }
}

function addRug(scene, cx, cz, w, d) {
  const tex = makeRugTexture()
  const rugMat = new THREE.MeshLambertMaterial({ map: tex })
  const rug = new THREE.Mesh(new THREE.PlaneGeometry(w + 0.35, d + 0.35), rugMat)
  rug.rotation.x = -Math.PI / 2
  rug.position.set(cx, 0.002, cz)
  rug.receiveShadow = true
  scene.add(rug)
}

// ── Floor texture — dark herringbone oak ──────────────────────────────────

function makeFloorTexture() {
  const size = 512
  const canvas = document.createElement('canvas')
  canvas.width = size; canvas.height = size
  const ctx = canvas.getContext('2d')

  ctx.fillStyle = '#8A6840'; ctx.fillRect(0, 0, size, size)

  const plankW = 64
  for (let x = 0; x < size; x += plankW) {
    ctx.fillStyle = 'rgba(50,30,10,0.30)'; ctx.fillRect(x, 0, 2, size)
    const shade = (Math.random() - 0.5) * 12
    ctx.fillStyle = `rgba(${shade > 0 ? 180 : 80},${Math.abs(shade) > 0 ? 130 : 60},40,${Math.abs(shade) / 600})`
    ctx.fillRect(x + 2, 0, plankW - 4, size)
    for (let g = 0; g < 5; g++) {
      const gx = x + 4 + (g / 4) * (plankW - 8)
      ctx.strokeStyle = `rgba(60,35,10,${0.06 + Math.random() * 0.05})`
      ctx.lineWidth = 0.9
      ctx.beginPath(); ctx.moveTo(gx, 0)
      ctx.bezierCurveTo(gx + (Math.random()-0.5)*5, size*0.33, gx + (Math.random()-0.5)*5, size*0.66, gx, size)
      ctx.stroke()
    }
  }
  for (let y = 80; y < size; y += 100 + Math.random() * 40) {
    ctx.fillStyle = 'rgba(50,30,10,0.18)'; ctx.fillRect(0, y, size, 1.5)
  }

  const tex = new THREE.CanvasTexture(canvas)
  tex.wrapS = tex.wrapT = THREE.RepeatWrapping
  tex.repeat.set(3, 8)
  return tex
}

// ── Back wall with large window opening ───────────────────────────────────

function addBackWindow(scene, roomW, roomH, roomD) {
  const wallMat  = new THREE.MeshLambertMaterial({ color: 0xE8E2D8 })
  const revealMat = new THREE.MeshLambertMaterial({ color: 0xEDE8E0 })
  const z = -roomD
  const depth = 0.30

  // Window shifted to right side of back wall
  const winW = 3.4, winH = 2.6
  const winCX = 2.0   // right of center
  const winBottom = 1.2, winTop = winBottom + winH
  const winCY = winBottom + winH / 2

  // ── Back wall face (4 panels around opening) ──
  const topH = roomH - winTop
  const leftW  = roomW / 2 + winCX - winW / 2   // wide left panel
  const rightW = roomW / 2 - winCX - winW / 2   // narrow right panel

  const topPanel = new THREE.Mesh(new THREE.PlaneGeometry(roomW, topH), wallMat)
  topPanel.position.set(0, winTop + topH / 2, z)
  scene.add(topPanel)

  const botPanel = new THREE.Mesh(new THREE.PlaneGeometry(roomW, winBottom), wallMat)
  botPanel.position.set(0, winBottom / 2, z)
  scene.add(botPanel)

  const leftPanel = new THREE.Mesh(new THREE.PlaneGeometry(leftW, winH), wallMat)
  leftPanel.position.set(-roomW / 2 + leftW / 2, winCY, z)
  scene.add(leftPanel)

  const rightPanel = new THREE.Mesh(new THREE.PlaneGeometry(rightW, winH), wallMat)
  rightPanel.position.set(roomW / 2 - rightW / 2, winCY, z)
  scene.add(rightPanel)

  // ── Reveal — inner faces of wall thickness ────
  const topRev = new THREE.Mesh(new THREE.PlaneGeometry(winW, depth), revealMat)
  topRev.rotation.x = Math.PI / 2
  topRev.position.set(winCX, winTop, z + depth / 2)
  scene.add(topRev)

  const sillMat = new THREE.MeshLambertMaterial({ color: 0x4A4640 })
  const sill = new THREE.Mesh(new THREE.BoxGeometry(winW + 0.12, 0.04, depth + 0.08), sillMat)
  sill.position.set(winCX, winBottom, z + depth / 2)
  scene.add(sill)

  const leftRev = new THREE.Mesh(new THREE.PlaneGeometry(depth, winH), revealMat)
  leftRev.rotation.y = Math.PI / 2
  leftRev.position.set(winCX - winW / 2, winCY, z + depth / 2)
  scene.add(leftRev)

  const rightRev = new THREE.Mesh(new THREE.PlaneGeometry(depth, winH), revealMat)
  rightRev.rotation.y = -Math.PI / 2
  rightRev.position.set(winCX + winW / 2, winCY, z + depth / 2)
  scene.add(rightRev)

  // ── View plane ─────────────────────────────────
  const viewMat = new THREE.MeshBasicMaterial({ map: makeWindowView() })
  const viewPlane = new THREE.Mesh(new THREE.PlaneGeometry(winW, winH), viewMat)
  viewPlane.position.set(winCX, winCY, z - 0.04)
  scene.add(viewPlane)

  // ── Glass pane ─────────────────────────────────
  const glassMat = new THREE.MeshLambertMaterial({
    color: 0xC8DCE8, transparent: true, opacity: 0.18,
    emissive: 0x6699AA, emissiveIntensity: 0.12
  })
  const glass = new THREE.Mesh(new THREE.PlaneGeometry(winW, winH), glassMat)
  glass.position.set(winCX, winCY, z + depth - 0.01)
  scene.add(glass)

  // ── Frame bars ─────────────────────────────────
  const frameMat = new THREE.MeshLambertMaterial({ color: 0x3A3632 })
  const ft = 0.07, fd = 0.08
  ;[
    [new THREE.BoxGeometry(winW + ft * 2, ft, fd), [winCX, winTop,           z + depth]],
    [new THREE.BoxGeometry(winW + ft * 2, ft, fd), [winCX, winBottom,        z + depth]],
    [new THREE.BoxGeometry(ft, winH, fd),           [winCX - winW/2, winCY,  z + depth]],
    [new THREE.BoxGeometry(ft, winH, fd),           [winCX + winW/2, winCY,  z + depth]],
    [new THREE.BoxGeometry(winW, ft * 0.7, fd),     [winCX, winCY,           z + depth]],
    [new THREE.BoxGeometry(ft * 0.7, winH, fd),     [winCX, winCY,           z + depth]],
  ].forEach(([geo, pos]) => {
    const bar = new THREE.Mesh(geo, frameMat)
    bar.position.set(...pos)
    scene.add(bar)
  })

  // ── Abstract painting on left side of back wall ─
  const artW = 1.8, artH = 1.3
  const artFrame = new THREE.Mesh(new THREE.BoxGeometry(artW + 0.07, artH + 0.07, 0.04), new THREE.MeshLambertMaterial({ color: 0x181818 }))
  artFrame.position.set(-2.2, 2.5, z + 0.02)
  scene.add(artFrame)
  const artTex = makeGestural(artW, artH)
  const art = new THREE.Mesh(new THREE.PlaneGeometry(artW, artH), new THREE.MeshLambertMaterial({ map: artTex }))
  art.position.set(-2.2, 2.5, z + 0.05)
  scene.add(art)

  // ── Daylight spill ─────────────────────────────
  const winLight = new THREE.PointLight(0xD8ECFF, 0.55, 10)
  winLight.position.set(winCX, winCY, z + 1.5)
  scene.add(winLight)
}

// ── Window view — city skyline, time-of-day ────────────────────────────────

// Consistent building silhouette — same skyline across all variants
const _CITY = [
  [0,   28, 105], [34,  24,  85], [64,  38, 125], [112, 22,  95],
  [142, 34, 120], [182, 26,  90], [215, 48, 110], [270, 30,  85],
  [308, 44, 135], [360, 30, 100], [400, 40, 115], [448, 24,  90],
  [480, 30, 110]
]

function _cityCanvas() {
  const canvas = document.createElement('canvas')
  canvas.width = 512; canvas.height = 200
  return { canvas, ctx: canvas.getContext('2d'), W: 512, H: 200 }
}

function _drawBuildings(ctx, H, bldgColor, winColor, winDensity) {
  for (const [bx, bw, bh] of _CITY) {
    ctx.fillStyle = bldgColor
    ctx.fillRect(bx, H - bh, bw, bh)
    if (winColor && winDensity > 0) {
      for (let wy = H - bh + 5; wy < H - 5; wy += 10) {
        for (let wx = bx + 3; wx < bx + bw - 3; wx += 7) {
          if (Math.random() < winDensity) {
            ctx.fillStyle = winColor
            ctx.fillRect(wx, wy, 3, 4)
          }
        }
      }
    }
  }
}

function makeWindowView() {
  const h = new Date().getHours()
  if (h >= 5  && h < 8)  return drawCityDawn()
  if (h >= 8  && h < 17) return drawCityDay()
  if (h >= 17 && h < 19) return drawCityGolden()
  if (h >= 19 && h < 21) return drawCityDusk()
  return drawCityNight()
}

function drawCityDawn() {
  const { canvas, ctx, W, H } = _cityCanvas()
  const sky = ctx.createLinearGradient(0, 0, 0, H * 0.75)
  sky.addColorStop(0, '#1A1428'); sky.addColorStop(0.4, '#C04828'); sky.addColorStop(1, '#F8A850')
  ctx.fillStyle = sky; ctx.fillRect(0, 0, W, H)
  // Sun just cresting horizon
  const glow = ctx.createRadialGradient(W * 0.5, H * 0.75, 0, W * 0.5, H * 0.75, W * 0.45)
  glow.addColorStop(0, 'rgba(255,210,100,0.7)'); glow.addColorStop(1, 'rgba(255,110,20,0)')
  ctx.fillStyle = glow; ctx.fillRect(0, 0, W, H)
  ctx.fillStyle = '#1A0C06'; ctx.fillRect(0, H * 0.75, W, H * 0.25)
  _drawBuildings(ctx, H, '#120804', 'rgba(255,220,130,0.5)', 0.35)
  return new THREE.CanvasTexture(canvas)
}

function drawCityDay() {
  const { canvas, ctx, W, H } = _cityCanvas()
  const sky = ctx.createLinearGradient(0, 0, 0, H)
  sky.addColorStop(0, '#3A78C8'); sky.addColorStop(0.7, '#7AAEE0'); sky.addColorStop(1, '#B8D4EE')
  ctx.fillStyle = sky; ctx.fillRect(0, 0, W, H)
  // Sun high up
  ctx.fillStyle = 'rgba(255,250,220,0.95)'
  ctx.beginPath(); ctx.arc(W * 0.78, H * 0.15, 14, 0, Math.PI * 2); ctx.fill()
  const glow = ctx.createRadialGradient(W * 0.78, H * 0.15, 0, W * 0.78, H * 0.15, 55)
  glow.addColorStop(0, 'rgba(255,248,200,0.35)'); glow.addColorStop(1, 'rgba(255,248,200,0)')
  ctx.fillStyle = glow; ctx.fillRect(0, 0, W, H)
  ctx.fillStyle = '#2A2E38'; ctx.fillRect(0, H * 0.72, W, H * 0.28)
  _drawBuildings(ctx, H, '#252830', null, 0)
  return new THREE.CanvasTexture(canvas)
}

function drawCityGolden() {
  const { canvas, ctx, W, H } = _cityCanvas()
  const sky = ctx.createLinearGradient(0, 0, 0, H)
  sky.addColorStop(0, '#7A3010'); sky.addColorStop(0.5, '#D87028'); sky.addColorStop(1, '#F8C060')
  ctx.fillStyle = sky; ctx.fillRect(0, 0, W, H)
  ctx.fillStyle = 'rgba(255,235,140,0.9)'
  ctx.beginPath(); ctx.arc(W * 0.72, H * 0.65, 18, 0, Math.PI * 2); ctx.fill()
  const glow = ctx.createRadialGradient(W * 0.72, H * 0.65, 0, W * 0.72, H * 0.65, 80)
  glow.addColorStop(0, 'rgba(255,220,80,0.55)'); glow.addColorStop(1, 'rgba(255,150,20,0)')
  ctx.fillStyle = glow; ctx.fillRect(0, 0, W, H)
  ctx.fillStyle = '#1E1008'; ctx.fillRect(0, H * 0.72, W, H * 0.28)
  _drawBuildings(ctx, H, '#180C04', 'rgba(255,230,140,0.4)', 0.15)
  return new THREE.CanvasTexture(canvas)
}

function drawCityDusk() {
  const { canvas, ctx, W, H } = _cityCanvas()
  const sky = ctx.createLinearGradient(0, 0, 0, H)
  sky.addColorStop(0, '#0E0A20'); sky.addColorStop(0.5, '#5A2870'); sky.addColorStop(1, '#C05830')
  ctx.fillStyle = sky; ctx.fillRect(0, 0, W, H)
  const glow = ctx.createRadialGradient(W * 0.5, H * 0.8, 0, W * 0.5, H * 0.8, W * 0.4)
  glow.addColorStop(0, 'rgba(220,100,40,0.5)'); glow.addColorStop(1, 'rgba(150,40,80,0)')
  ctx.fillStyle = glow; ctx.fillRect(0, 0, W, H)
  ctx.fillStyle = '#0A0810'; ctx.fillRect(0, H * 0.72, W, H * 0.28)
  _drawBuildings(ctx, H, '#080610', 'rgba(255,225,140,0.65)', 0.5)
  return new THREE.CanvasTexture(canvas)
}

function drawCityNight() {
  const { canvas, ctx, W, H } = _cityCanvas()
  const sky = ctx.createLinearGradient(0, 0, 0, H)
  sky.addColorStop(0, '#02040A'); sky.addColorStop(1, '#080E1C')
  ctx.fillStyle = sky; ctx.fillRect(0, 0, W, H)
  for (let i = 0; i < 65; i++) {
    ctx.fillStyle = `rgba(255,255,255,${0.2 + Math.random() * 0.7})`
    ctx.fillRect(Math.random() * W, Math.random() * H * 0.5, 1, 1)
  }
  ctx.fillStyle = 'rgba(235,235,210,0.9)'
  ctx.beginPath(); ctx.arc(W * 0.15, H * 0.18, 10, 0, Math.PI * 2); ctx.fill()
  ctx.fillStyle = '#06060E'; ctx.fillRect(0, H * 0.72, W, H * 0.28)
  for (const [bx, bw, bh] of _CITY) {
    ctx.fillStyle = '#04040C'
    ctx.fillRect(bx, H - bh, bw, bh)
    for (let wy = H - bh + 5; wy < H - 5; wy += 9) {
      for (let wx = bx + 3; wx < bx + bw - 3; wx += 6) {
        if (Math.random() < 0.65) {
          ctx.fillStyle = Math.random() > 0.45
            ? 'rgba(255,225,140,0.8)' : 'rgba(140,195,255,0.6)'
          ctx.fillRect(wx, wy, 3, 4)
        }
      }
    }
  }
  return new THREE.CanvasTexture(canvas)
}

// ── Rug canvas texture ─────────────────────────────────────────────────────

function makeRugTexture() {
  const W = 1024, H = 1024
  const canvas = document.createElement('canvas')
  canvas.width = W; canvas.height = H
  const ctx = canvas.getContext('2d')

  // Base — deep charcoal with subtle warm undertone
  const baseBg = ctx.createLinearGradient(0, 0, W, H)
  baseBg.addColorStop(0, '#1A1A1E')
  baseBg.addColorStop(0.5, '#22222A')
  baseBg.addColorStop(1, '#1A1A1E')
  ctx.fillStyle = baseBg; ctx.fillRect(0, 0, W, H)

  // Subtle noise texture
  for (let i = 0; i < 6000; i++) {
    const nx = Math.random() * W, ny = Math.random() * H
    ctx.fillStyle = `rgba(255,255,255,${Math.random() * 0.025})`
    ctx.fillRect(nx, ny, 1, 1)
  }

  // Thin border — barely-there warm taupe
  const b = 16
  ctx.strokeStyle = 'rgba(180,160,130,0.25)'; ctx.lineWidth = 1.5
  ctx.strokeRect(b, b, W - 2 * b, H - 2 * b)

  // Inner fine border
  ctx.strokeStyle = 'rgba(180,160,130,0.12)'; ctx.lineWidth = 0.8
  ctx.strokeRect(b + 10, b + 10, W - 2 * (b + 10), H - 2 * (b + 10))

  // Geometric pattern — overlapping translucent arcs (modern/minimal)
  ctx.globalCompositeOperation = 'lighter'

  // Large off-center circles
  const circles = [
    { x: W * 0.35, y: H * 0.38, r: 160, color: '140,120,90' },
    { x: W * 0.65, y: H * 0.55, r: 130, color: '120,130,140' },
    { x: W * 0.50, y: H * 0.46, r: 100, color: '160,140,110' },
  ]
  for (const c of circles) {
    ctx.strokeStyle = `rgba(${c.color},0.08)`; ctx.lineWidth = 1.5
    ctx.beginPath(); ctx.arc(c.x, c.y, c.r, 0, Math.PI * 2); ctx.stroke()
    ctx.strokeStyle = `rgba(${c.color},0.05)`; ctx.lineWidth = 0.8
    ctx.beginPath(); ctx.arc(c.x, c.y, c.r * 0.75, 0, Math.PI * 2); ctx.stroke()
  }

  // Diagonal thin lines — asymmetric modernist feel
  ctx.globalCompositeOperation = 'source-over'
  const lineColor = 'rgba(180,165,135,0.07)'
  ctx.strokeStyle = lineColor; ctx.lineWidth = 0.8
  for (let i = -6; i <= 6; i++) {
    const offset = i * 80
    ctx.beginPath()
    ctx.moveTo(W * 0.3 + offset, b + 30)
    ctx.lineTo(W * 0.7 + offset, H - b - 30)
    ctx.stroke()
  }

  // Subtle horizontal bands at thirds
  for (const fy of [0.33, 0.66]) {
    const grad = ctx.createLinearGradient(0, H * fy - 20, 0, H * fy + 20)
    grad.addColorStop(0, 'rgba(160,145,120,0)')
    grad.addColorStop(0.5, 'rgba(160,145,120,0.06)')
    grad.addColorStop(1, 'rgba(160,145,120,0)')
    ctx.fillStyle = grad
    ctx.fillRect(b + 20, H * fy - 20, W - 2 * (b + 20), 40)
  }

  // Small center accent — single clean dot
  ctx.fillStyle = 'rgba(200,180,140,0.15)'
  ctx.beginPath(); ctx.arc(W / 2, H / 2, 4, 0, Math.PI * 2); ctx.fill()

  return new THREE.CanvasTexture(canvas)
}
