// Robust JSON-array extractor. Finds the first balanced top-level `[...]`
// in the string (ignoring brackets inside string literals) so trailing
// prose, stray code fences, or explanatory text don't break parsing.
// Returns the parsed array, or [] on failure.

export function extractJsonArray(raw) {
  if (!raw) return []
  const start = raw.indexOf('[')
  if (start < 0) return []

  let depth = 0
  let inStr = false
  let esc = false
  for (let i = start; i < raw.length; i++) {
    const ch = raw[i]
    if (esc) { esc = false; continue }
    if (ch === '\\') { esc = true; continue }
    if (ch === '"') { inStr = !inStr; continue }
    if (inStr) continue
    if (ch === '[') depth++
    else if (ch === ']') {
      depth--
      if (depth === 0) {
        const slice = raw.slice(start, i + 1)
        try { return JSON.parse(slice) } catch { return [] }
      }
    }
  }
  return []
}
