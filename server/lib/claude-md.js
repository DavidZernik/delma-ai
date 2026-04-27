// Read, parse, and write CLAUDE.md — the project's living memory file.
//
// CLAUDE.md replaces the Supabase-backed memory_notes/org_memory_notes rows
// in Delma's local-first rewrite. One file per project, four canonical
// sections, committed to the project's git repo, edited either by the user
// in their IDE or by Delma through typed ops.
//
// File shape (enforced on first create, tolerated on read):
//
//   # <Project Name>
//
//   <optional one-line project summary>
//
//   ## Project Details
//   <anything — Mermaid flowcharts, decision logs, open actions>
//
//   ## General Notes
//   <conventions, rules, unwritten norms, links to longer docs>
//
//   ## File Locations and Keys
//   <env vars, MIDs, customer keys, SFMC folder paths — the boring lookup table>
//
// Sections that don't exist on read are treated as empty strings. Writes
// always emit all three in canonical order so files stay predictable.

import { readFileSync, existsSync } from 'node:fs'
import { basename, resolve as resolvePath } from 'node:path'
import { atomicWrite } from './local-config.js'

export const SECTION_KEYS = ['projectDetails', 'generalNotes', 'fileLocations']

// Human heading → internal key. Kept strict — if the user renames a heading
// we treat it as custom content inside the parent section rather than a new
// recognized section.
const SECTION_HEADINGS = {
  'Project Details':         'projectDetails',
  'General Notes':           'generalNotes',
  'File Locations and Keys': 'fileLocations'
}

// Legacy heading aliases. Files written by older Delma versions had
// different section names; we fold their content into the closest current
// section on read so nothing's lost. The next write serializes with the
// current headings, completing the migration silently. If a legacy heading
// AND a current heading both exist, the merge concatenates them — better
// than overwriting if the user has both for some reason.
const LEGACY_HEADINGS = {
  'General Patterns and Docs':  'generalNotes',  // direct rename
  'Integrations':               'generalNotes',  // closest current section
  'People':                     'generalNotes',  // closest current section
  'Files, Locations, and Keys': 'fileLocations', // direct rename, comma-style
  'Files Locations and Keys':   'fileLocations'  // direct rename, no commas
}

// We only emit the canonical names back out — legacy names exist only on
// the read path.
const KEY_TO_HEADING = {
  projectDetails: 'Project Details',
  generalNotes:   'General Notes',
  fileLocations:  'File Locations and Keys'
}

// True if a section body has no real content — only seed-template prose
// or placeholder hints. Used to drop legacy starter content during the
// fold-into-current-sections migration. Heuristic: zero bullets, zero
// subsections, and contains an `_(...)_` italic placeholder line OR is
// just a single short description sentence.
function isPlaceholderOnly(body) {
  if (!body) return true
  const lines = body.split('\n').map(l => l.trim()).filter(Boolean)
  if (lines.length === 0) return true
  const hasBullet = lines.some(l => /^[-*]\s/.test(l))
  const hasH3 = lines.some(l => /^###\s/.test(l))
  const hasFence = lines.some(l => /^```/.test(l))
  if (hasBullet || hasH3 || hasFence) return false
  const hasPlaceholder = lines.some(l => /^_\([^)]+\)_$/.test(l))
  if (hasPlaceholder) return true
  // No structure at all + no placeholder + only a sentence or two → also
  // treat as placeholder; the legacy seeds were always one-paragraph hints.
  return lines.length <= 2
}

// Parse a CLAUDE.md string into { title, summary, sections: {...} }.
// Tolerant: missing sections → empty strings. Content before the first
// recognized ## heading is treated as the "preamble" (title + summary).
export function parseClaudeMd(text) {
  const src = String(text || '')
  const sections = { projectDetails: '', generalNotes: '', fileLocations: '' }

  // Extract the H1 title + optional one-line summary from the preamble.
  let title = null
  let summary = null
  const firstH1 = src.match(/^\s*#\s+(.+?)\s*$/m)
  if (firstH1) title = firstH1[1].trim()
  const afterH1 = firstH1 ? src.slice(firstH1.index + firstH1[0].length) : src
  const summaryMatch = afterH1.match(/^\s*(?!#)(.+?)\s*$/m)
  if (summaryMatch && summaryMatch[1].trim()) summary = summaryMatch[1].trim()

  // Split on H2 headings. Each match captures (heading, body-until-next-H2).
  // Legacy headings fold into their current-section equivalent; if both an
  // old and new heading point at the same key, concatenate so nothing's
  // lost in transit. Placeholder-only bodies (seed templates with no real
  // user content) are dropped so they don't pollute the merged section.
  const h2Re = /^##\s+(.+?)\s*$/gm
  const matches = [...src.matchAll(h2Re)]
  for (let i = 0; i < matches.length; i++) {
    const m = matches[i]
    const heading = m[1].trim()
    const key = SECTION_HEADINGS[heading] || LEGACY_HEADINGS[heading]
    if (!key) continue
    const bodyStart = m.index + m[0].length
    const bodyEnd = i + 1 < matches.length ? matches[i + 1].index : src.length
    const body = src.slice(bodyStart, bodyEnd).replace(/^\s*\n/, '').trimEnd()
    if (isPlaceholderOnly(body)) continue
    if (sections[key]) sections[key] += '\n\n' + body
    else sections[key] = body
  }

  return { title, summary, sections }
}

// Serialize back to a CLAUDE.md string. Canonical order, each section always
// present (empty → empty body). Single trailing newline.
export function serializeClaudeMd({ title, summary, sections }) {
  const s = sections || {}
  const lines = []
  if (title) lines.push(`# ${title}`, '')
  if (summary) lines.push(summary, '')
  for (const key of SECTION_KEYS) {
    lines.push(`## ${KEY_TO_HEADING[key]}`, '')
    const body = (s[key] || '').trim()
    if (body) { lines.push(body, '') }
    else { lines.push('_(empty)_', '') }
  }
  return lines.join('\n').replace(/\n{3,}/g, '\n\n').trimEnd() + '\n'
}

// Load a CLAUDE.md from a project folder. Returns null if absent.
// Caller decides whether missing-file → seed or error.
export function readClaudeMd(projectDir) {
  const filePath = resolvePath(projectDir, 'CLAUDE.md')
  if (!existsSync(filePath)) return null
  const raw = readFileSync(filePath, 'utf8')
  return { filePath, raw, ...parseClaudeMd(raw) }
}

// Overwrite CLAUDE.md. Atomic: a crash or power cut during write leaves
// the old file intact rather than a half-written mess.
export function writeClaudeMd(projectDir, parsed) {
  const filePath = resolvePath(projectDir, 'CLAUDE.md')
  atomicWrite(filePath, serializeClaudeMd(parsed))
  return filePath
}

// Starter template — used when the user opens a folder that has no CLAUDE.md.
// Kept short on purpose; each section has one seed line the user replaces.
// The Project Details section starts with an empty Mermaid fence so the
// diagram renderer finds something to render from turn one.
export function starterTemplate({ projectName, oneLiner } = {}) {
  const name = projectName || basename(process.cwd())
  return {
    title: name,
    summary: oneLiner || 'One-line description of what this project is.',
    sections: {
      projectDetails: [
        'System flow, decisions, and open actions for this project.',
        '',
        '### Decisions',
        '_(empty)_',
        '',
        '### Actions',
        '_(empty)_'
      ].join('\n'),
      generalNotes: [
        'Conventions, rules, unwritten norms, links to longer docs.',
        '',
        '_(none captured yet)_'
      ].join('\n'),
      fileLocations: [
        'Env vars, business-unit IDs, customer keys, and SFMC folder paths used by this project. This is the lookup table — paste an ID once, find it forever.',
        '',
        '_(none captured yet)_'
      ].join('\n')
    }
  }
}

// Idempotent: if CLAUDE.md exists, return it. If not, seed from the template
// and return the seeded content. `inheritedSections` (optional) lets the
// caller paste in already-good content for the org-level sections so a new
// project starts with the team's conventions instead of empty placeholders.
// Project Details is never inherited — that's project-specific by design.
export function readOrSeedClaudeMd(projectDir, { projectName, oneLiner, inheritedSections } = {}) {
  const existing = readClaudeMd(projectDir)
  if (existing) return existing
  const parsed = starterTemplate({ projectName, oneLiner })
  if (inheritedSections) {
    for (const k of ['generalNotes', 'fileLocations']) {
      const inherited = inheritedSections[k]
      if (inherited && inherited.trim()) parsed.sections[k] = inherited
    }
  }
  const filePath = writeClaudeMd(projectDir, parsed)
  return { filePath, raw: serializeClaudeMd(parsed), ...parsed }
}
