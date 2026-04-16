#!/usr/bin/env node
// One-shot backfill: convert legacy markdown content → structured JSON.
//
// For every memory_notes + org_memory_notes row whose filename is a
// structured tab and whose `structured` column is still NULL:
//   1. Parse the current markdown content into structured JSON (deterministic
//      parsers for the easy four; Haiku-assisted for people.md).
//   2. Re-render from structured (so `content` becomes the canonical view).
//   3. Write both back.
//
// Safe to re-run — it skips rows that already have `structured` set.
//
// Usage: node scripts/backfill-structured.js [--dry] [--filename=people.md]

import { config as loadEnv } from 'dotenv'
loadEnv({ override: true })
import { createClient } from '@supabase/supabase-js'
import { render, emptyData, isStructuredTab } from '../src/tab-ops.js'
import { parseStructuredContent } from '../server/lib/parse-tab.js'

const argv = process.argv.slice(2)
const DRY = argv.includes('--dry')
const FILENAME_FILTER = (argv.find(a => a.startsWith('--filename=')) || '').split('=')[1] || null

if (!process.env.SUPABASE_URL || !process.env.SUPABASE_SERVICE_ROLE_KEY) {
  console.error('SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY required in .env')
  process.exit(1)
}
if (!process.env.ANTHROPIC_API_KEY) {
  console.error('ANTHROPIC_API_KEY required for People parsing')
  process.exit(1)
}

const sb = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY, {
  auth: { autoRefreshToken: false, persistSession: false }
})

function looksEmpty(md) {
  const m = (md || '').trim()
  if (!m) return true
  // If it matches the canonical empty template (just the header + seed prose), treat as empty.
  const stripped = m.replace(/\s+/g, ' ').toLowerCase()
  return stripped.length < 120 && !/```/.test(stripped)
}

async function backfillRows(table) {
  const { data: rows, error } = await sb.from(table).select('*')
  if (error) throw new Error(`${table}: ${error.message}`)

  let done = 0, skipped = 0, failed = 0
  for (const row of rows) {
    if (FILENAME_FILTER && row.filename !== FILENAME_FILTER) continue
    if (!isStructuredTab(row.filename)) { skipped++; continue }
    if (row.structured) { skipped++; continue }

    console.log(`→ ${table}/${row.filename} (id=${row.id.slice(0, 8)}) ...`)

    let structured
    if (looksEmpty(row.content)) {
      structured = emptyData(row.filename)
      console.log(`  empty — using default shape`)
    } else {
      try {
        structured = await parseStructuredContent(row.filename, row.content, { anthropicKey: process.env.ANTHROPIC_API_KEY })
        const counts = summarize(row.filename, structured)
        console.log(`  parsed — ${counts}`)
      } catch (err) {
        console.error(`  FAILED: ${err.message}`)
        failed++
        continue
      }
    }

    const content = render(row.filename, structured)

    if (DRY) {
      console.log(`  [dry] would write structured (${JSON.stringify(structured).length} chars) + content (${content.length} chars)`)
      done++
      continue
    }

    const { error: updErr } = await sb.from(table).update({ structured, content }).eq('id', row.id)
    if (updErr) { console.error(`  save failed: ${updErr.message}`); failed++; continue }
    console.log(`  ✓ saved`)
    done++
  }
  return { done, skipped, failed }
}

function summarize(filename, data) {
  if (filename === 'people.md') return `${data.people?.length || 0} people`
  if (filename === 'playbook.md') return `${data.rules?.length || 0} rules`
  if (filename === 'environment.md') return `${data.entries?.length || 0} entries`
  if (filename === 'decisions.md') return `${data.decisions?.length || 0} decisions, ${data.actions?.length || 0} actions`
  if (filename === 'my-notes.md') return `${(data.text || '').length} chars`
  return JSON.stringify(data).length + ' chars'
}

console.log(DRY ? '🧪 DRY RUN — no writes' : '🔨 LIVE — will write to Supabase')
if (FILENAME_FILTER) console.log(`filter: filename=${FILENAME_FILTER}`)

const a = await backfillRows('memory_notes')
const b = await backfillRows('org_memory_notes')

console.log(`\n━━━ DONE ━━━`)
console.log(`memory_notes:     ${a.done} done, ${a.skipped} skipped, ${a.failed} failed`)
console.log(`org_memory_notes: ${b.done} done, ${b.skipped} skipped, ${b.failed} failed`)
