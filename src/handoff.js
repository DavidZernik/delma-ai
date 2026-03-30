import * as THREE from 'three'

/**
 * Creates a single reusable handoff object (glowing plane + point light).
 * Call send(fromChar, toChar) to animate a handoff between two characters.
 * Returns a promise that resolves when the animation completes.
 */
export function createHandoffSystem(scene) {
  const geo = new THREE.PlaneGeometry(0.16, 0.10)
  const mat = new THREE.MeshStandardMaterial({
    color: 0xD4A853,
    emissive: 0xD4A853,
    emissiveIntensity: 1.2,
    transparent: true,
    opacity: 1,
    side: THREE.DoubleSide,
    depthWrite: false
  })

  const mesh = new THREE.Mesh(geo, mat)
  mesh.visible = false
  scene.add(mesh)

  const light = new THREE.PointLight(0xFFAA33, 0, 1.5)
  scene.add(light)

  function send(fromChar, toChar) {
    return new Promise(resolve => {
      const start = new THREE.Vector3(
        fromChar.group.position.x,
        1.25,
        fromChar.group.position.z
      )
      const end = new THREE.Vector3(
        toChar.group.position.x,
        1.25,
        toChar.group.position.z
      )

      mat.opacity = 1
      light.intensity = 0.6
      mesh.visible = true

      const DURATION = 1400   // ms
      const PEAK     = 0.45   // m above start/end Y
      const startTime = performance.now()

      function step() {
        const elapsed = performance.now() - startTime
        const t = Math.min(1, elapsed / DURATION)
        const ease = t < 0.5 ? 2 * t * t : -1 + (4 - 2 * t) * t

        mesh.position.lerpVectors(start, end, ease)
        mesh.position.y = start.y + PEAK * Math.sin(Math.PI * t)
        mesh.rotation.z = t * Math.PI * 2   // gentle spin

        light.position.copy(mesh.position)

        if (t < 1) {
          requestAnimationFrame(step)
          return
        }

        // Arrived — fade out
        const fadeStart = performance.now()
        function fadeOut() {
          const ft = Math.min(1, (performance.now() - fadeStart) / 350)
          mat.opacity  = 1 - ft
          light.intensity = 0.6 * (1 - ft)

          if (ft < 1) {
            requestAnimationFrame(fadeOut)
          } else {
            mesh.visible = false
            mat.opacity = 1
            light.intensity = 0

            // Dashed trail — builds the communication map over the chain run
            const trailGeo = new THREE.BufferGeometry().setFromPoints([start.clone(), end.clone()])
            const trailMat = new THREE.LineDashedMaterial({
              color: 0xD4A853, transparent: true, opacity: 0, dashSize: 0.15, gapSize: 0.1
            })
            const trail = new THREE.Line(trailGeo, trailMat)
            trail.computeLineDistances()
            scene.add(trail)
            ;(async () => {
              for (let i = 0; i <= 10; i++) { trailMat.opacity = (i / 10) * 0.3; await new Promise(r => setTimeout(r, 30)) }
              await new Promise(r => setTimeout(r, 4500))
              for (let i = 10; i >= 0; i--) { trailMat.opacity = (i / 10) * 0.3; await new Promise(r => setTimeout(r, 40)) }
              scene.remove(trail)
              trailGeo.dispose()
              trailMat.dispose()
            })()

            resolve()
          }
        }
        requestAnimationFrame(fadeOut)
      }

      requestAnimationFrame(step)
    })
  }

  return { send }
}
