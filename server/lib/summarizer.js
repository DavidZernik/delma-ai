// ──────────────────────────────────────────────────────────────────────────────
// Delma Auto-Summarizer
// ──────────────────────────────────────────────────────────────────────────────
//
// Summarizes the full workspace state into a compact ~500-token snapshot
// and writes it to a local CLAUDE.md file. Claude Code auto-loads CLAUDE.md
// on every turn, so the summary is always in context.
//
// Trigger: called after every MCP write (save_diagram_view, append_memory_note)
// and at session start via the hook.
//
// Uses Haiku (cheap, fast) for summarization. Falls back to a simple
// text-based summary if no API key is available.
//
// ──────────────────────────────────────────────────────────────────────────────

import { config } from 'dotenv'
config()

const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY

/**
 * Build a plain-text dump of the workspace for the summarizer to read.
 */
function buildFullContext(views, memoryMap, orgName, workspaceName) {
  const parts = []

  if (orgName) parts.push(`Organization: ${orgName}`)
  if (workspaceName) parts.push(`Workspace: ${workspaceName}`)
  parts.push('')

  for (const view of views || []) {
    parts.push(`## ${view.title}`)
    if (view.description) parts.push(view.description)
    if (view.mermaid) parts.push(view.mermaid.replace(/^---\n[\s\S]*?\n---\n?/, '').trim())
    parts.push('')
  }

  for (const [file, content] of Object.entries(memoryMap || {})) {
    if (content?.trim()) {
      parts.push(`## ${file}`)
      parts.push(content.trim())
      parts.push('')
    }
  }

  return parts.join('\n')
}

/**
 * Call Haiku to produce a concise summary of the workspace.
 * Target: ~500 tokens — enough for Claude to stay oriented,
 * not enough to waste context on every turn.
 */
async function summarizeWithHaiku(fullContext) {
  if (!ANTHROPIC_API_KEY) return null

  try {
    const res = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': ANTHROPIC_API_KEY,
        'anthropic-version': '2023-06-01'
      },
      body: JSON.stringify({
        model: 'claude-haiku-4-20250414',
        max_tokens: 600,
        messages: [{
          role: 'user',
          content: `Summarize this project workspace into a concise reference that an AI assistant will read at the start of every message. Include: project name, team members and roles, current status, key systems/IDs, and what needs to happen next. Be factual and terse. No fluff. Max 400 words.\n\n${fullContext}`
        }]
      })
    })

    if (!res.ok) return null
    const data = await res.json()
    return data.content?.[0]?.text || null
  } catch {
    return null
  }
}

/**
 * Fallback: build a simple summary without an LLM.
 * Just extracts the first line of each section.
 */
function simpleSummary(views, memoryMap, orgName, workspaceName) {
  const parts = []

  if (orgName && workspaceName) {
    parts.push(`# ${orgName} / ${workspaceName}`)
  } else {
    parts.push(`# ${workspaceName || 'Delma Workspace'}`)
  }
  parts.push('')

  for (const view of views || []) {
    parts.push(`**${view.title}:** ${view.description || '(no description)'}`)
  }

  for (const [file, content] of Object.entries(memoryMap || {})) {
    if (content?.trim()) {
      // First non-heading line
      const firstLine = content.split('\n').find(l => l.trim() && !l.startsWith('#')) || ''
      parts.push(`**${file}:** ${firstLine.trim().slice(0, 120)}`)
    }
  }

  return parts.join('\n')
}

/**
 * Generate the full CLAUDE.md content: behavior instructions + workspace summary.
 */
export async function generateClaudeMd(views, memoryMap, orgName, workspaceName) {
  const fullContext = buildFullContext(views, memoryMap, orgName, workspaceName)

  // Try Haiku first, fall back to simple summary
  const summary = await summarizeWithHaiku(fullContext) || simpleSummary(views, memoryMap, orgName, workspaceName)

  return `# Delma Workspace

Write to Delma when the user confirms a fact:
- \`append_memory_note\` for people, logic, environment, or session updates
- \`save_diagram_view\` for architecture or diagram changes

Only write confirmed facts. Never write inferences. Batch updates.
Before writing to a tab, re-read it first to avoid overwriting recent edits.

---

## Current Workspace Summary

${summary}
`
}
