import * as THREE from 'three'
import { CSS2DRenderer } from 'three/examples/jsm/renderers/CSS2DRenderer.js'

export const LEFT_FRAC = 0.40

export function initScene() {
  const scene = new THREE.Scene()
  scene.background = new THREE.Color(0xEAE2D8)
  scene.fog = new THREE.Fog(0xEAE2D8, 17, 30)

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
  const ambientLight = new THREE.AmbientLight(0xFFF5E8, 0.70)
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
  const fillLight = new THREE.DirectionalLight(0xFFEAD0, 0.30)
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
  const ceilMat = new THREE.MeshLambertMaterial({ color: 0xF8F5F0 })
  const ceil = new THREE.Mesh(new THREE.PlaneGeometry(ROOM_W, ROOM_D), ceilMat)
  ceil.rotation.x = Math.PI / 2
  ceil.position.set(0, ROOM_H, -ROOM_D / 2)
  scene.add(ceil)

  // ── Walls ─────────────────────────────────────
  // Back wall — statement color (deep warm sage)
  const backWallMat = new THREE.MeshLambertMaterial({ color: 0xC8BAAA })
  const backWall = new THREE.Mesh(new THREE.PlaneGeometry(ROOM_W, ROOM_H), backWallMat)
  backWall.position.set(0, ROOM_H / 2, -ROOM_D)
  scene.add(backWall)

  // Left wall — warm off-white
  addWall(scene, new THREE.PlaneGeometry(ROOM_D, ROOM_H), -ROOM_W / 2, ROOM_H / 2, -ROOM_D / 2, Math.PI / 2)

  // Front wall (entrance) — warm off-white
  const frontWallMat = new THREE.MeshLambertMaterial({ color: 0xEEE6DC })
  const frontWall = new THREE.Mesh(new THREE.PlaneGeometry(ROOM_W, ROOM_H), frontWallMat)
  frontWall.position.set(0, ROOM_H / 2, 0)
  frontWall.rotation.y = Math.PI
  scene.add(frontWall)

  // Right wall — windows + panels
  addWindowWall(scene, ROOM_W / 2, ROOM_H, ROOM_D)

  // ── Wainscoting — lower wall panels for richness ─
  addWainscoting(scene, ROOM_W, ROOM_H, ROOM_D)

  // ── Ceiling trim / cornice ──────────────────────
  addCornice(scene, ROOM_W, ROOM_H, ROOM_D)

  // ── Pendant lights ───────────────────────────────
  addPendant(scene,  0,    ROOM_H, -3.5)   // Over Sarah
  addPendant(scene, -0.6,  ROOM_H, -9)     // Over James
  addPendant(scene,  1.0,  ROOM_H, -9)     // Over Marcus
  addPendant(scene,  0.2,  ROOM_H, -12)    // Over Priya
  addPendant(scene,  0,    ROOM_H, -6)     // Aisle fill
  addPendant(scene,  0,    ROOM_H, -16)    // Back fill

  // ── Furniture ────────────────────────────────────
  const screens = {
    delma:  addDesk(scene,  0,    -3.5,  2.4, true,  false),
    james:  addDesk(scene, -0.6,  -9,    1.4, false, false),
    marcus: addDesk(scene,  1.0,  -9,    1.4, false, false),
    sarah:  addDesk(scene,  0.2,  -12,   1.4, false, true)
  }

  // Chairs
  addChair(scene, -0.6, -9,   false)  // James
  addChair(scene,  1.0, -9,   false)  // Marcus
  addChair(scene,  0.2, -12,  true)   // Priya — reversed chair (on -Z side)

  // ── Paintings on right wall ─────────────────────
  addPainting(scene, 4.35, 2.2, -5.5, 'right', 'landscape')
  addPainting(scene, 4.35, 2.2, -11,  'right', 'abstract')

  // ── Whiteboard (left wall, mid-room) ─────────────
  addWhiteboard(scene, -4.3, 2.1, -14)

  // ── Storage unit (back-left) ─────────────────────
  addBookshelf(scene, -3.8, -17)

  // ── Plants ───────────────────────────────────────
  addPlant(scene,  3.8,  -1.5, 1.0)
  addPlant(scene, -4.0,  -1.5, 1.0)
  addPlant(scene, -4.0,  -14,  0.8)
  addPlant(scene,  3.8,  -17,  0.9)

  // ── Divider between desk banks ───────────────────
  addDivider(scene, 0, -10.5)

  // ── Area rug ─────────────────────────────────────
  addRug(scene, 0.2, -10.5, 6.5, 9.5)
  return screens
}

// ── Helpers ───────────────────────────────────────────────────────────────

function addWall(scene, geo, x, y, z, ry) {
  const mat = new THREE.MeshLambertMaterial({ color: 0xEEE6DC })
  const mesh = new THREE.Mesh(geo, mat)
  mesh.position.set(x, y, z)
  mesh.rotation.y = ry
  scene.add(mesh)
}

function addWindowWall(scene, wallX, roomH, roomD) {
  const wallMat  = new THREE.MeshLambertMaterial({ color: 0xEEE6DC })
  const glassMat = new THREE.MeshLambertMaterial({
    color: 0xC4D8E8, transparent: true, opacity: 0.32,
    emissive: 0x88AACC, emissiveIntensity: 0.35
  })
  const frameMat = new THREE.MeshLambertMaterial({ color: 0xF4F0E8 })

  const windowPositions = [-5, -9, -13, -17]
  const windowH = 2.3, windowW = 1.9

  const fullWall = new THREE.Mesh(new THREE.PlaneGeometry(roomD, roomH), wallMat)
  fullWall.rotation.y = -Math.PI / 2
  fullWall.position.set(wallX, roomH / 2, -roomD / 2)
  scene.add(fullWall)

  for (const wz of windowPositions) {
    const frameOuter = new THREE.Mesh(
      new THREE.BoxGeometry(0.08, windowH + 0.14, windowW + 0.14), frameMat
    )
    frameOuter.position.set(wallX - 0.04, 1.8 + windowH / 2, wz)
    scene.add(frameOuter)

    const glass = new THREE.Mesh(new THREE.PlaneGeometry(windowW, windowH), glassMat)
    glass.rotation.y = -Math.PI / 2
    glass.position.set(wallX - 0.02, 1.8 + windowH / 2, wz)
    scene.add(glass)

    // Window cross bars
    const barMat = new THREE.MeshLambertMaterial({ color: 0xF0ECE4 })
    const hBar = new THREE.Mesh(new THREE.BoxGeometry(0.06, 0.04, windowW), barMat)
    hBar.position.set(wallX - 0.01, 1.8 + windowH / 2, wz)
    scene.add(hBar)
    const vBar = new THREE.Mesh(new THREE.BoxGeometry(0.06, windowH, 0.04), barMat)
    vBar.position.set(wallX - 0.01, 1.8 + windowH / 2, wz)
    scene.add(vBar)

    const winLight = new THREE.PointLight(0xFFF5E0, 0.5, 9)
    winLight.position.set(wallX - 1.2, 2.6, wz)
    scene.add(winLight)
  }
}

function addWainscoting(scene, w, h, d) {
  const mat = new THREE.MeshLambertMaterial({ color: 0xD8CEBC })
  const panelH = 0.9
  // Left wall wainscoting
  const leftPanel = new THREE.Mesh(new THREE.BoxGeometry(0.025, panelH, d), mat)
  leftPanel.position.set(-w / 2 + 0.012, panelH / 2, -d / 2)
  scene.add(leftPanel)
  // Back wall
  const backPanel = new THREE.Mesh(new THREE.BoxGeometry(w, panelH, 0.025), mat)
  backPanel.position.set(0, panelH / 2, -d)
  scene.add(backPanel)
  // Cap rail (top of wainscoting)
  const capMat = new THREE.MeshLambertMaterial({ color: 0xC8BEAA })
  const leftCap = new THREE.Mesh(new THREE.BoxGeometry(0.055, 0.04, d), capMat)
  leftCap.position.set(-w / 2 + 0.02, panelH + 0.02, -d / 2)
  scene.add(leftCap)
}

function addCornice(scene, w, h, d) {
  const mat = new THREE.MeshLambertMaterial({ color: 0xF0EAE0 })
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
  const bulbMat  = new THREE.MeshLambertMaterial({ color: 0xFFEEAA, emissive: 0xFFEEAA, emissiveIntensity: 3.0 })

  const y = ceilY - 0.05
  const cord = new THREE.Mesh(new THREE.CylinderGeometry(0.005, 0.005, 0.65, 6), cordMat)
  cord.position.set(x, y - 0.33, z); scene.add(cord)

  const shade = new THREE.Mesh(new THREE.CylinderGeometry(0.22, 0.06, 0.20, 16), shadeMat)
  shade.position.set(x, y - 0.76, z); scene.add(shade)

  const rim = new THREE.Mesh(new THREE.TorusGeometry(0.215, 0.010, 8, 24),
    new THREE.MeshLambertMaterial({ color: 0x444440 }))
  rim.rotation.x = Math.PI / 2; rim.position.set(x, y - 0.67, z); scene.add(rim)

  const bulb = new THREE.Mesh(new THREE.SphereGeometry(0.040, 8, 6), bulbMat)
  bulb.position.set(x, y - 0.76, z); scene.add(bulb)

  const light = new THREE.PointLight(0xFFD890, 1.6, 6)
  light.position.set(x, y - 0.84, z); scene.add(light)
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

function addPainting(scene, x, y, z, wall, style) {
  const paintW = style === 'landscape' ? 1.4 : 1.1
  const paintH = style === 'landscape' ? 0.9 : 1.2
  const frameMat = new THREE.MeshLambertMaterial({ color: 0x2C2018 })
  const fw = paintW + 0.10, fh = paintH + 0.10

  // Frame (facing -X for right wall)
  const frame = new THREE.Mesh(new THREE.BoxGeometry(0.06, fh, fw), frameMat)
  frame.position.set(x, y, z); scene.add(frame)

  // Canvas texture
  const tex = style === 'landscape' ? makeLandscapePainting(paintW, paintH)
                                     : makeAbstractPainting(paintW, paintH)
  const canvasMat = new THREE.MeshLambertMaterial({ map: tex })
  const canvas = new THREE.Mesh(new THREE.PlaneGeometry(paintW, paintH), canvasMat)
  canvas.rotation.y = -Math.PI / 2
  canvas.position.set(x - 0.04, y, z); scene.add(canvas)

  // Subtle picture light above
  const lightMat = new THREE.MeshLambertMaterial({ color: 0xBBAA88 })
  const picLight = new THREE.Mesh(new THREE.CylinderGeometry(0.03, 0.04, paintW * 0.7, 8), lightMat)
  picLight.rotation.z = Math.PI / 2
  picLight.position.set(x - 0.02, y + paintH / 2 + 0.12, z); scene.add(picLight)
  const picGlow = new THREE.PointLight(0xFFEECC, 0.6, 3)
  picGlow.position.set(x - 0.3, y + paintH / 2 + 0.05, z); scene.add(picGlow)
}

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
  // Navy/teal area rug with border
  const borderMat = new THREE.MeshLambertMaterial({ color: 0x1C2838 })
  const border = new THREE.Mesh(new THREE.PlaneGeometry(w + 0.35, d + 0.35), borderMat)
  border.rotation.x = -Math.PI / 2; border.position.set(cx, 0.001, cz); scene.add(border)

  const rugMat = new THREE.MeshLambertMaterial({ color: 0x243040 })
  const rug = new THREE.Mesh(new THREE.PlaneGeometry(w, d), rugMat)
  rug.rotation.x = -Math.PI / 2; rug.position.set(cx, 0.002, cz); scene.add(rug)

  // Inner border stripe
  const stripeMat = new THREE.MeshLambertMaterial({ color: 0x8A7040 })
  const stripeOuter = new THREE.Mesh(new THREE.PlaneGeometry(w - 0.15, d - 0.15), stripeMat)
  stripeOuter.rotation.x = -Math.PI / 2; stripeOuter.position.set(cx, 0.003, cz); scene.add(stripeOuter)
  const stripeInner = new THREE.Mesh(new THREE.PlaneGeometry(w - 0.35, d - 0.35), rugMat)
  stripeInner.rotation.x = -Math.PI / 2; stripeInner.position.set(cx, 0.004, cz); scene.add(stripeInner)
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
