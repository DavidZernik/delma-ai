// Normalize diagram storage on save:
//
//   1. Inside the fence: duplicate `classDef <name>` lines get deduped
//      (first occurrence wins so the on-brand block survives), and
//      verbose `class NodeId ClassName` statements get stripped since
//      we standardize on `:::ClassName` inline syntax.
//   2. Outside the fence (prose above): same stripping for stray
//      mermaid syntax the model sometimes leaks into the markdown.
//   3. Everything AFTER the closing fence is discarded. Project Details
//      is a header + diagram, never a diagram + trailing prose — the
//      model occasionally dumps classDefs or leftover commentary there
//      and it has no place to render. Hard cut.
//
// Works on either pure mermaid or a markdown doc with an embedded fence.

const STRAY_CLASS_RE = /^class\s+\S+\s+\w+\s*$/
const CLASSDEF_RE = /^classDef\s+(\w+)\b/

export function cleanMermaid(input) {
  if (typeof input !== 'string' || !input.trim()) return input

  const fenceMatch = input.match(/^([\s\S]*?```mermaid\n)([\s\S]*?)(\n```)[\s\S]*$/)
  if (!fenceMatch) {
    // No fence — treat the whole input as mermaid body.
    return cleanInsideFence(input)
  }

  const [, prefix, body, closer] = fenceMatch
  return cleanOutsideFence(prefix) + cleanInsideFence(body) + closer + '\n'
}

function cleanInsideFence(body) {
  const seen = new Set()
  return body
    .split('\n')
    .filter((line) => {
      const trimmed = line.trim()
      if (STRAY_CLASS_RE.test(trimmed)) return false
      const m = trimmed.match(CLASSDEF_RE)
      if (m) {
        if (seen.has(m[1])) return false
        seen.add(m[1])
      }
      return true
    })
    .join('\n')
}

function cleanOutsideFence(text) {
  return text
    .split('\n')
    .filter((line) => {
      const trimmed = line.trim()
      if (STRAY_CLASS_RE.test(trimmed)) return false
      if (CLASSDEF_RE.test(trimmed)) return false
      return true
    })
    .join('\n')
}
