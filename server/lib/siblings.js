// Sibling-project discovery + inheritance.
//
// All Delma projects live as folders under one parent directory ("the
// projects root"). When the user opens a NEW project, we look for sibling
// folders that already have a `CLAUDE.md` and offer to inherit their org-
// level sections (General Notes + File Locations and Keys). Project Details
// is never inherited — that's the project-specific tab and starts fresh.
//
// "Sibling" = a directory that shares the target's parent directory and
// contains a `CLAUDE.md` at its root. We don't crawl deeper.

import { readdirSync, statSync, existsSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { readClaudeMd } from './claude-md.js'

// List sibling projects of `projectDir` (the dir itself need not exist —
// we look at its parent). Returns [{ path, name }, ...] sorted by name.
// Hidden folders (starting with `.`) are skipped to keep the list clean.
export function findSiblings(projectDir) {
  const parent = dirname(projectDir)
  if (!existsSync(parent)) return []
  let entries = []
  try { entries = readdirSync(parent) } catch { return [] }
  const out = []
  for (const name of entries) {
    if (name.startsWith('.')) continue
    const path = join(parent, name)
    if (path === projectDir) continue
    let st
    try { st = statSync(path) } catch { continue }
    if (!st.isDirectory()) continue
    if (!existsSync(join(path, 'CLAUDE.md'))) continue
    const doc = readClaudeMd(path)
    out.push({ path, name: doc?.title || name })
  }
  out.sort((a, b) => a.name.localeCompare(b.name))
  return out
}

// Read the inheritable sections from a sibling's CLAUDE.md. Returns null if
// the source has no readable CLAUDE.md. Project Details is intentionally
// excluded so the new project's diagram + decisions + actions start fresh.
export function readInheritedSections(sourceProjectDir) {
  const doc = readClaudeMd(sourceProjectDir)
  if (!doc) return null
  return {
    generalNotes: doc.sections.generalNotes || '',
    fileLocations: doc.sections.fileLocations || ''
  }
}
