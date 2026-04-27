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

// The user sees 4 tabs: Project Details, Integrations, General Patterns and
// Docs, People. Internally, Project Details is backed by decisions.md
// (decisions + actions) and environment.md (IDs, keys, folder conventions).
// Prompt headers include the sub-section in parens so the agent can tell
// the two data shapes apart; the "tab" field in <delma-suggest> must use
// only the clean user-facing names (see the How-saving-works section).
const TAB_LABEL = {
  'decisions.md':   'Project Details (Decisions & Actions)',
  'environment.md': 'Project Details (Files Locations and Keys)',
  'people.md':      'People',
  'playbook.md':    'General Patterns and Docs'
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
  lines.push(`- **Writes to SFMC** (POST/PUT/PATCH/DELETE) are offer-and-confirm: state the exact change, wait for Yes, then write. Never auto-write. Reads are free.`)
  lines.push(`- **Writes to Delma's docs** (any \`mcp__delma__*\` mutation) are automatically gated by the app — the user gets a Yes/No card before the tool actually runs. So go ahead and CALL the tool directly rather than asking "want me to save this?" in text. The UI handles the confirmation.`)
  lines.push(``)
  lines.push(`## How saving works in Delma`)
  lines.push(`**You do not call any \`mcp__delma__*\` tools yourself.** At the END of every response, evaluate the exchange and propose saves as a structured block. The UI turns each proposal into a clickable button — the user reviews and clicks Yes to apply. Nothing writes until the user clicks.`)
  lines.push(``)
  lines.push(`After your main response text, if (and only if) the exchange contains something durable to save, append EXACTLY this block (nothing else after it):`)
  lines.push(`<delma-suggest>`)
  lines.push(`[`)
  lines.push(`  {"tab": "Project Details", "summary": "human-readable description of the change", "tool": "mcp__delma__delma_add_decision", "input": { ...tool args... }}`)
  lines.push(`]`)
  lines.push(`</delma-suggest>`)
  lines.push(``)
  lines.push(`**"tab" must be one of:** \`Project Details\`, \`General Patterns and Docs\`, \`People\`. No other values.`)
  lines.push(``)
  lines.push(`**How to route:**`)
  lines.push(`- Goals, definitions, open questions, campaign choices → tab: \`Project Details\`, tool: \`mcp__delma__delma_add_decision\` or \`mcp__delma__delma_add_action\``)
  lines.push(`- Folder conventions, DE names, IDs, keys, URLs, SFMC locations → tab: \`Project Details\`, tool: \`mcp__delma__delma_set_environment_key\``)
  lines.push(`- Architecture updates (a new DE, journey, query in the pipeline) → tab: \`Project Details\`, tool: appropriate \`mcp__delma__delma_arch_*\``)
  lines.push(`- Operational rules, unwritten norms, org-wide patterns → tab: \`General Patterns and Docs\`, tool: \`mcp__delma__delma_add_playbook_rule\``)
  lines.push(`- People, roles, reporting lines → tab: \`People\`, tool: appropriate \`mcp__delma__delma_add_person\` / \`delma_set_role\` / etc.`)
  lines.push(``)
  lines.push(`**If nothing is worth saving, omit the block entirely — do NOT send an empty array or a placeholder.** A response with no durable content should just be prose.`)
  lines.push(``)
  lines.push(`**One suggestion per distinct fact.** If the user shares three decisions in one message, emit three entries.`)
  lines.push(``)
  lines.push(`**Open questions and missing info ARE saveable.** Whenever your prose identifies a "we don't know X yet" or "need to define Y" or lists what's missing, propose an \`mcp__delma__delma_add_action\` for EACH such item. Don't just list them in prose and move on.`)
  lines.push(``)
  lines.push(`**Concrete example.** If the user says "we're doing a winback campaign, lapsed = 90 days no engagement" and lapsed isn't saved yet, and you respond noting the project needs a source DE and a Parent BU MID defined, your block MUST include:`)
  lines.push(`<delma-suggest>`)
  lines.push(`[`)
  lines.push(`  {"tab": "Project Details", "summary": "Define lapsed patient as 90 days of no engagement", "tool": "mcp__delma__delma_add_decision", "input": {"text": "Lapsed patient = 90 days of no email engagement", "owner": "<user>"}},`)
  lines.push(`  {"tab": "Project Details", "summary": "Identify source DE for patient data", "tool": "mcp__delma__delma_add_action", "input": {"text": "Identify source DE name for lapsed-patient data", "owner": "<user>"}},`)
  lines.push(`  {"tab": "Project Details", "summary": "Document Parent BU MID", "tool": "mcp__delma__delma_add_action", "input": {"text": "Document Parent BU MID for API access", "owner": "<user>"}}`)
  lines.push(`]`)
  lines.push(`</delma-suggest>`)
  lines.push(``)
  lines.push(`**Check against what's already saved.** If a fact the user mentions is already in the Project Tabs shown above, skip that one — don't re-propose duplicates. But OPEN QUESTIONS you surface in prose should almost always have matching suggestions even if related facts exist.`)
  lines.push(``)
  lines.push(`**Filesystem** (Bash/Write/Read): turn-local scratchpad only — ephemeral, not visible anywhere. Never write prose, docs, or anything the user needs back. Use it only for intermediate JSON, throwaway scripts, grep buffers.`)
  lines.push(`- Be concise. The user is non-technical, works in marketing ops. Lead with the answer, then the detail.`)
  lines.push(``)

  // ── Scratch directory — turn-local, ephemeral ─────────────────────────────
  // The cwd is a scratchpad, not a store. Anything Claude writes here can
  // vanish at any time (OS /tmp purge, server restart, future deploy). We
  // never advertise it as durable — durable state lives in Supabase tabs.
  if (projectDir) {
    lines.push(`## Scratchpad (cwd)`)
    lines.push(`- Current working directory: \`${projectDir}\``)
    lines.push(`- **This is a turn-local scratchpad, not durable storage.** Use it for intermediate JSON, throwaway scripts, grep buffers. Files here can disappear at any time. Do not use it for anything the user or a teammate needs back — that goes through the memory tools above.`)
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
