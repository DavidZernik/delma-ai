// Build the per-turn system prompt for the in-app chat.
//
// Pulls everything Claude needs to act as the user's SFMC operator on a
// specific project: the project's diagram + memory tabs (decisions, env keys,
// notes), the org's general patterns and people, and a description of the
// SFMC connections wired up. The prompt also tells Claude how to use the
// env vars + Bash for SFMC API calls.
//
// Tab labels mirror the user-facing names from src/main.js (MEMORY_TAB_LABELS
// + ORG_TAB_LABELS). The chat refers to tabs by what the user sees, not the
// underlying filenames.

import { supabase as sb } from '../lib/supabase.js'
import { SYSTEM_PROMPT_DYNAMIC_BOUNDARY } from '@anthropic-ai/claude-agent-sdk'

const TAB_LABEL = {
  // Project-level
  'decisions.md':  'Project Details',
  'environment.md': 'Files Locations and Keys',
  // Org-level
  'people.md':     'People',
  'playbook.md':   'General Patterns and Docs'
}
function tabLabel(filename) {
  return TAB_LABEL[filename] || filename
}

// Keep prior turns within a sane budget. Drop oldest first when we exceed.
// 60K chars of conversation ≈ 15K tokens, leaving room for the project
// context (~9K) + the user's new message + Claude's reply within a 200K
// context window.
const HISTORY_CHAR_BUDGET = 60_000

export function priorConversationBlock(messages) {
  if (!messages?.length) return ''

  // Newest-first prune: keep adding from the end until we hit the budget,
  // then reverse for chronological output. Each message is formatted to
  // include any tool_calls the assistant made that turn (and tool results)
  // so Claude can see evidence of its prior actions, not just its summary
  // prose. Without this, Claude doubts itself and re-verifies.
  const format = (m) => {
    if (m.role === 'user') {
      const text = String(m.content || '').trim()
      return text ? `**user:** ${text}` : ''
    }
    if (m.role === 'assistant') {
      const text = String(m.content || '').trim()
      const tools = Array.isArray(m.tool_calls) ? m.tool_calls : []
      const toolLines = tools.map(t => {
        let inputStr
        try { inputStr = JSON.stringify(t.input) } catch { inputStr = '(unserializable)' }
        if (inputStr.length > 300) inputStr = inputStr.slice(0, 300) + '…'
        return `  → called \`${t.name}\` ${inputStr}`
      })
      if (!text && !toolLines.length) return ''
      return [`**assistant:** ${text}`, ...toolLines].filter(Boolean).join('\n')
    }
    if (m.role === 'tool') {
      // content is a JSON array of { tool_use_id, output }
      let results
      try { results = JSON.parse(m.content || '[]') } catch { results = [] }
      if (!Array.isArray(results) || !results.length) return ''
      return results.map(r => {
        let out = String(r.output || '').trim()
        if (out.length > 400) out = out.slice(0, 400) + '…'
        return `**tool_result:** ${out}`
      }).join('\n')
    }
    return ''
  }

  const kept = []
  let used = 0
  for (let i = messages.length - 1; i >= 0; i--) {
    const block = format(messages[i])
    if (!block) continue
    if (used + block.length > HISTORY_CHAR_BUDGET) break
    kept.unshift(block)
    used += block.length + 2
  }
  if (!kept.length) return ''
  const dropped = messages.length - kept.length
  const header = dropped > 0
    ? `## Prior Conversation (last ${kept.length} entries; ${dropped} older dropped to fit)`
    : `## Prior Conversation`
  return [header, '', ...kept, ''].join('\n')
}

export async function buildChatSystemPrompt({ projectId, orgId, sfmcAccounts, priorMessages = [], projectDir = null, sharedDir = null }) {
  const [project, org, views, memoryRows, orgMemoryRows] = await Promise.all([
    sb.from('projects').select('id, name').eq('id', projectId).maybeSingle().then(r => r.data),
    sb.from('organizations').select('id, name').eq('id', orgId).maybeSingle().then(r => r.data),
    sb.from('diagram_views').select('view_key, title, description, mermaid').eq('project_id', projectId).then(r => r.data || []),
    sb.from('memory_notes').select('filename, content').eq('project_id', projectId).then(r => r.data || []),
    sb.from('org_memory_notes').select('filename, content').eq('org_id', orgId).then(r => r.data || [])
  ])

  const lines = []
  lines.push(`# Delma — In-app SFMC Operator`)
  lines.push(``)
  lines.push(`You are the in-app collaborator for this SFMC project. You see the project's full state below and act on the user's behalf to inspect, plan, and modify the campaign — including hitting the SFMC API directly via Bash + curl when needed.`)
  lines.push(``)
  lines.push(`**How to behave:**`)
  lines.push(`- Stay grounded in the project context below. Don't ask questions whose answers are already in front of you.`)
  lines.push(`- The project docs are a CACHE, not the source of truth. When the user names a specific SFMC asset (ID, customer key, or name), fetch the live version first and reconcile against the docs. Only fall back to docs alone if SFMC is unreachable.`)
  lines.push(`- **Any write — to SFMC (POST/PUT/PATCH/DELETE) OR to Delma's docs (any \`delma_*\` mutation) — is offer-and-confirm: state the exact change, wait for Yes, then write.** Never auto-write. Reads are free.`)
  lines.push(`- When the user shares durable knowledge (rules, playbooks, context worth keeping), offer to save it using the available memory tools. If one tab clearly fits, propose that one; if it could fit multiple, ask the user.`)
  lines.push(`  - **Memory tools available:** \`delma_add_playbook_rule\` (org-wide Patterns), \`delma_arch_set_node_note\` (per-node notes on the Project Details diagram), \`delma_add_decision\` / \`delma_set_environment_key\` (Project Details facts), Write to \`$DELMA_SHARED_DIR\` (reusable scripts). If the user's message reads like a playbook, rules list, or operational guide rather than a question, your FIRST response should propose saving it — don't absorb it as context and move on.`)
  lines.push(`- Be concise. The user is non-technical, works in marketing ops. Lead with the answer, then the detail.`)
  lines.push(``)

  // ── Scratch directory layout ──────────────────────────────────────────────
  // Two-tier on-disk workspace: project dir (default cwd) + org-shared dir
  // for reusable scripts. Same SFMC creds work in both, so a fetch script
  // written for one project is reusable by any project in this org.
  if (projectDir) {
    lines.push(`## Working Directories`)
    lines.push(`- **Project dir (cwd):** \`${projectDir}\` — campaign-specific scratch (JSON snapshots, one-off scripts).`)
    if (sharedDir) {
      lines.push(`- **Shared org dir:** \`${sharedDir}\` (also \`$DELMA_SHARED_DIR\`) — reusable scripts that'd work for any project in this org. Check here before writing a new script.`)
    }
    lines.push(``)
  }

  // ── Project + Org identity ────────────────────────────────────────────────
  lines.push(`## Active Project`)
  lines.push(`- **Org:** ${org?.name || '(unknown)'} (${orgId})`)
  lines.push(`- **Project:** ${project?.name || '(unknown)'} (${projectId})`)
  lines.push(``)

  // ── SFMC connections ──────────────────────────────────────────────────────
  lines.push(`## SFMC Connections`)
  if (!sfmcAccounts || (!sfmcAccounts.child && !sfmcAccounts.parent)) {
    lines.push(`No SFMC account is connected for this org yet. The user can connect one in the Integrations tab. Until then, plan and document but don't attempt SFMC API calls.`)
  } else {
    if (sfmcAccounts.child) {
      const c = sfmcAccounts.child
      lines.push(`### Child BU (default for sends/journeys)`)
      lines.push(`- Label: ${c.label || '(unnamed)'}`)
      lines.push(`- MID: ${c.account_id || '(unset)'}`)
      lines.push(`- Subdomain: ${(c.rest_base_url || '').match(/^https?:\/\/([^.]+)\./)?.[1] || '(unknown)'}`)
      lines.push(`- Env vars: \`CLIENT_ID\`, \`CLIENT_SECRET\`, \`SFMC_SUBDOMAIN\`, \`SFMC_MID\`, \`SFMC_AUTH_BASE_URL\`, \`SFMC_REST_BASE_URL\`, \`SFMC_SOAP_BASE_URL\``)
    }
    if (sfmcAccounts.parent) {
      const p = sfmcAccounts.parent
      lines.push(`### Parent BU (enterprise data, account API)`)
      lines.push(`- Label: ${p.label || '(unnamed)'}`)
      lines.push(`- MID: ${p.account_id || '(unset)'}`)
      lines.push(`- Env vars: \`PARENT_BU_CLIENT_ID\`, \`PARENT_BU_CLIENT_SECRET\`, \`PARENT_BU_MID\`, \`PARENT_BU_AUTH_BASE_URL\`, \`PARENT_BU_REST_BASE_URL\`, \`PARENT_BU_SOAP_BASE_URL\``)
    }
    lines.push(``)
    lines.push(`**Use the \`delma_sfmc_*\` MCP tools for all SFMC operations.** Delma handles OAuth, SOAP envelope construction, REST payloads, and error normalization — you just pass plain JSON. Do NOT hand-roll curl/SOAP XML; that's a known failure mode.`)
    lines.push(``)
    lines.push(`Available SFMC tools:`)
    lines.push(`- \`delma_sfmc_list_des\` — check what DEs already exist (call this BEFORE creating to avoid duplicates)`)
    lines.push(`- \`delma_sfmc_get_de\` — fetch a DE's schema (fields, types, PK)`)
    lines.push(`- \`delma_sfmc_create_de\` — create a Data Extension`)
    lines.push(`- \`delma_sfmc_insert_rows\` — upsert rows into a DE`)
    lines.push(`- \`delma_sfmc_create_query_activity\` — create a SQL Query Activity that writes to a target DE`)
    lines.push(`- \`delma_sfmc_run_query\` — trigger a Query Activity immediately`)
    lines.push(`- \`delma_sfmc_create_automation\` — build an automation from Query Activity / import / extract steps`)
    lines.push(`- \`delma_sfmc_run_automation\` — start an automation outside its schedule`)
    lines.push(`- \`delma_sfmc_check_automation_status\` — poll status / last run / next run`)
    lines.push(``)
    lines.push(`Each tool takes an optional \`bu: "child" | "parent"\` (default: child). Tools return \`{ ok: true, ... }\` or \`{ ok: false, code, message }\` — check \`ok\` and surface the error cleanly if something fails.`)
    lines.push(``)
    lines.push(`Shell access (\`Bash\`) is still available for one-off reads SFMC doesn't expose as a tool (checking SQL results, exploring a specific asset). OAuth + env vars (\`$SFMC_AUTH_BASE_URL\`, \`$SFMC_REST_BASE_URL\`, \`$CLIENT_ID\`, \`$CLIENT_SECRET\`, etc.) are still set for that case.`)
  }
  lines.push(``)

  // ── Architecture diagrams ─────────────────────────────────────────────────
  if (views?.length) {
    lines.push(`## Architecture Diagrams`)
    for (const v of views) {
      lines.push(`### ${v.title}`)
      if (v.description) lines.push(v.description)
      if (v.mermaid) {
        lines.push('```mermaid')
        lines.push(v.mermaid.trim())
        lines.push('```')
      }
      lines.push('')
    }
  }

  // ── Project tabs (Project Details, Files Locations and Keys) ─────────────
  if (memoryRows?.length) {
    lines.push(`## Project Tabs`)
    for (const row of memoryRows) {
      if (!row.content?.trim()) continue
      lines.push(`### ${tabLabel(row.filename)}`)
      lines.push(row.content.trim())
      lines.push(``)
    }
  }

  // ── Org tabs (General Patterns and Docs, People) ─────────────────────────
  if (orgMemoryRows?.length) {
    lines.push(`## Org Tabs`)
    for (const row of orgMemoryRows) {
      if (!row.content?.trim()) continue
      lines.push(`### ${tabLabel(row.filename)}`)
      lines.push(row.content.trim())
      lines.push(``)
    }
  }

  // Everything above this point is the "static prefix" — same across turns
  // within a session, eligible for Anthropic prompt caching. The prior
  // conversation grows every turn, so it goes AFTER the boundary marker.
  const staticPrefix = lines.join('\n')

  // Per-turn injection trace — what Delma actually fed into Claude this turn.
  // Split so you can see at a glance which sections were populated vs empty.
  const memoryTabs = (memoryRows || []).filter(r => r.content?.trim()).map(r => tabLabel(r.filename))
  const orgTabs = (orgMemoryRows || []).filter(r => r.content?.trim()).map(r => tabLabel(r.filename))
  console.log('[delma inject]',
    'project:', project?.name || projectId?.slice(0, 8),
    'org:', org?.name || orgId?.slice(0, 8),
    'sfmc:', [sfmcAccounts?.child && 'child', sfmcAccounts?.parent && 'parent'].filter(Boolean).join('+') || 'none',
    'diagrams:', views?.length || 0,
    'projectTabs:[' + memoryTabs.join(',') + ']',
    'orgTabs:[' + orgTabs.join(',') + ']',
    'priorTurns:', priorMessages.length,
    'staticChars:', staticPrefix.length
  )

  const priorBlock = priorConversationBlock(priorMessages)
  if (!priorBlock) return staticPrefix // nothing dynamic — return as plain string

  // Returning as string[] with the SDK's boundary marker tells the Agent SDK
  // to cache everything before it. First request pays full price; subsequent
  // requests within ~5 min pay 10% on the cached portion.
  return [staticPrefix, SYSTEM_PROMPT_DYNAMIC_BOUNDARY, priorBlock]
}
