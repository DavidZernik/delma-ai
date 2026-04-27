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
const KEY_TO_HEADING = Object.fromEntries(
  Object.entries(SECTION_HEADINGS).map(([heading, key]) => [key, heading])
)

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
  const h2Re = /^##\s+(.+?)\s*$/gm
  const matches = [...src.matchAll(h2Re)]
  for (let i = 0; i < matches.length; i++) {
    const m = matches[i]
    const heading = m[1].trim()
    const key = SECTION_HEADINGS[heading]
    if (!key) continue // unrecognized sub-heading — ignored here
    const bodyStart = m.index + m[0].length
    const bodyEnd = i + 1 < matches.length ? matches[i + 1].index : src.length
    sections[key] = src.slice(bodyStart, bodyEnd).replace(/^\s*\n/, '').trimEnd()
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
