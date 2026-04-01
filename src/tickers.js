// Ticker system — queue-based, fade in / hold / fade out

export const sleep = ms => new Promise(r => setTimeout(r, ms))

const FADE = 200  // ms for fade in/out

/**
 * Set ticker content persistently — fire-and-forget, no auto-fadeout.
 * Safe to call from parallel async paths. Uses textContent to prevent XSS.
 */
export function setTicker(el, text, baseOpacity = 1.0) {
  if (el._css2dObj) el._css2dObj.visible = true
  el.style.transition = 'none'
  el.style.opacity = '0'
  el.textContent = text
  void el.offsetHeight
  el.style.transition = `opacity ${FADE}ms ease`
  el.style.opacity = String(baseOpacity)
}

/**
 * Show a single line in the ticker.
 * Returns a promise that resolves when the fade-out completes.
 */
export function showLine(el, text, holdMs = 1200, baseOpacity = 1.0) {
  return new Promise(resolve => {
    if (el._css2dObj) el._css2dObj.visible = true
    el.style.transition = 'none'
    el.style.opacity = '0'
    el.textContent = text
    void el.offsetHeight

    el.style.transition = `opacity ${FADE}ms ease`
    el.style.opacity = String(baseOpacity)

    setTimeout(() => {
      el.style.opacity = '0'
      setTimeout(() => {
        if (el._css2dObj) el._css2dObj.visible = false
        resolve()
      }, FADE)
    }, FADE + holdMs)
  })
}

/**
 * Show an array of lines sequentially.
 */
export async function showLines(el, lines, baseOpacity = 1.0) {
  for (const line of lines) {
    await showLine(el, line.text ?? line.html ?? line, line.hold ?? 1200, baseOpacity)
    await sleep(80)
  }
}

/**
 * Cycle through working messages until signal.done === true.
 */
export async function workingTicker(el, messages, baseOpacity, signal) {
  if (el._css2dObj) el._css2dObj.visible = true
  let i = 0

  while (!signal.done) {
    const msg = messages[i % messages.length]
    el.style.transition = 'none'
    el.style.opacity = '0'
    el.textContent = msg
    void el.offsetHeight

    el.style.transition = `opacity ${FADE}ms ease`
    el.style.opacity = String(baseOpacity)

    // Wait in 100ms chunks so we can bail quickly when done
    for (let j = 0; j < 18 && !signal.done; j++) {
      await sleep(100)
    }

    if (!signal.done) {
      el.style.opacity = '0'
      await sleep(FADE)
    }

    i++
  }

  el.style.opacity = '0'
  if (el._css2dObj) el._css2dObj.visible = false
}
