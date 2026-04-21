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

function priorConversationBlock(messages) {
  if (!messages?.length) return ''
  // Newest-first prune: keep adding from the end until we hit the budget,
  // then reverse for chronological output.
  const kept = []
  let used = 0
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i]
    const text = String(m.content || '').trim()
    if (!text) continue
    const block = `**${m.role}:** ${text}`
    if (used + block.length > HISTORY_CHAR_BUDGET) break
    kept.unshift(block)
    used += block.length + 2
  }
  if (!kept.length) return ''
  const dropped = messages.length - kept.length
  const header = dropped > 0
    ? `## Prior Conversation (last ${kept.length} turns; ${dropped} older turns dropped to fit)`
    : `## Prior Conversation`
  return [header, '', ...kept, ''].join('\n')
}

export async function buildChatSystemPrompt({ projectId, orgId, sfmcAccounts, priorMessages = [] }) {
  const [project, org, views, memoryRows, orgMemoryRows, appPerms] = await Promise.all([
    sb.from('projects').select('id, name').eq('id', projectId).maybeSingle().then(r => r.data),
    sb.from('organizations').select('id, name').eq('id', orgId).maybeSingle().then(r => r.data),
    sb.from('diagram_views').select('view_key, title, description, mermaid').eq('project_id', projectId).then(r => r.data || []),
    sb.from('memory_notes').select('filename, content').eq('project_id', projectId).then(r => r.data || []),
    sb.from('org_memory_notes').select('filename, content').eq('org_id', orgId).then(r => r.data || []),
    sb.from('project_app_permissions').select('app_id, permission').eq('project_id', projectId).then(r => r.data || [])
  ])
  const sfmcPermission = appPerms.find(p => p.app_id === 'sfmc')?.permission || 'read_only'

  const lines = []
  lines.push(`# Delma — In-app SFMC Operator`)
  lines.push(``)
  lines.push(`You are the in-app collaborator for this SFMC project. You see the project's full state below and act on the user's behalf to inspect, plan, and modify the campaign — including hitting the SFMC API directly via Bash + curl when needed.`)
  lines.push(``)
  lines.push(`**How to behave:**`)
  lines.push(`- Stay grounded in the project context below. Do not ask questions whose answers are already in front of you.`)
  lines.push(`- **When the user references a live SFMC object by ID, customer key, or name, always fetch the live version from the SFMC API FIRST before answering.** The project docs ("Files Locations and Keys", decisions, etc.) are a CACHE, not the source of truth. Pull live, then reconcile: if docs and live agree, say so; if they've drifted, call out the diff explicitly. Only rely on docs alone if SFMC is unreachable.`)
  lines.push(`- **When you detect drift between docs and live SFMC, do not just mention it — propose the fix as a question and wait for confirmation before writing.** Example: "Your Files Locations and Keys tab still points at asset 264938. SFMC shows the current asset is 267232 (renamed to brand_all_hbd_2026-final). Want me to update the docs?" Only after the user says yes, call the appropriate MCP write tool (\`delma_set_environment_key\`, \`delma_add_decision\`, etc.). Never auto-write — sometimes drift is intentional (a staging copy, a deliberate rename the user isn't ready to canonicalize).`)
  lines.push(`- **The Project Details view shows the architecture diagram at the top and a node-by-node guide below.** Every node in the architecture diagram has a \`note\` field that appears as a paragraph under the node's heading in that guide. When the user asks about a specific step, automation, data extension, or journey that corresponds to a node, propose writing or updating that node's note — with a concise English explanation of what the node is, how it works, and the related files/SQL/journey IDs. Use \`delma_arch_set_node_note\` (propose the exact text first, then write after user confirms). Goal: over time, every node has a crisp paragraph so Project Details is self-documenting.`)
  lines.push(`- **Whenever a node note names a file, journey, automation, data extension, CloudPage, or SQL query, write the full SFMC path inline using \`>\` separators** — e.g., \`Content Builder > Journeys > Brand > brand_all_hbd_2026-final\`, \`Automation Studio > Birthday_Daily_Send_Refresh\`, \`Data Extensions > Shared > ENT.All_Patients_Opted_In\`, \`Journey Builder > Birthday Daily Email Journey v2\`. Never use just the asset name alone — always the path so the user knows exactly where to click in SFMC. If you don't already know the path, fetch it from SFMC (asset \`category.name\` for Content Builder assets, category tree for DEs, etc.) before writing the note.`)
  lines.push(`- When the user asks about a piece of the campaign generally (not a specific asset), you may use "Files Locations and Keys" as your starting point, but still verify against live SFMC when it's material to the answer.`)
  lines.push(`- For SFMC API calls, use Bash + curl with the env vars below (CLIENT_ID, CLIENT_SECRET, SFMC_SUBDOMAIN, etc.). Cache the OAuth token across calls in the same turn.`)
  lines.push(`- Be concise. The user is non-technical and works in marketing operations. Lead with the answer, then the detail.`)
  lines.push(``)

  // ── Project + Org identity ────────────────────────────────────────────────
  lines.push(`## Active Project`)
  lines.push(`- **Org:** ${org?.name || '(unknown)'} (${orgId})`)
  lines.push(`- **Project:** ${project?.name || '(unknown)'} (${projectId})`)
  lines.push(``)

  // ── SFMC connections ──────────────────────────────────────────────────────
  lines.push(`## SFMC Connections`)
  if (!sfmcAccounts || (!sfmcAccounts.child && !sfmcAccounts.parent)) {
    lines.push(`No SFMC account is connected for this org yet. The user can connect one via the **Connections** drawer (button in the workspace footer). Until then, you can plan and document but not actually call SFMC.`)
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
    lines.push(`**OAuth quick-reference:** \`POST $SFMC_AUTH_BASE_URL/v2/token\` with \`{ grant_type: "client_credentials", client_id, client_secret, account_id (MID) }\` returns \`access_token\`. Use as Bearer token on REST/SOAP calls. Tokens last ~20 min.`)
    lines.push(``)
    lines.push(`### SFMC access level for this project: **${sfmcPermission === 'read_write' ? 'READ + WRITE' : 'READ ONLY'}**`)
    if (sfmcPermission === 'read_only') {
      lines.push(`- You may GET information from SFMC (REST GETs, SOAP Retrieve/Describe).`)
      lines.push(`- Do NOT call any endpoint that mutates SFMC state: POST, PUT, PATCH, DELETE on REST; Create/Update/Delete/Perform on SOAP. This includes creating drafts or duplicating assets — ANY write is off-limits until the user switches this project to "Read + write" in the Connected Apps tab.`)
      lines.push(`- Writing local scripts, saving JSON snapshots, and editing Delma docs is fine — those don't touch SFMC.`)
      lines.push(`- If the user asks for something that requires a write, explain that the project is in Read-only mode and point them to the **Connected Apps** tab to change it.`)
    } else {
      lines.push(`- You may read AND write to SFMC. Still confirm destructive actions (DELETE, live-journey edits) with the user before running them.`)
    }
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
      if (row.filename === 'my-notes.md') continue // private — skip from prompt
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
  const memoryTabs = (memoryRows || []).filter(r => r.content?.trim() && r.filename !== 'my-notes.md').map(r => tabLabel(r.filename))
  const orgTabs = (orgMemoryRows || []).filter(r => r.content?.trim()).map(r => tabLabel(r.filename))
  console.log('[delma inject]',
    'project:', project?.name || projectId?.slice(0, 8),
    'org:', org?.name || orgId?.slice(0, 8),
    'sfmc:', [sfmcAccounts?.child && 'child', sfmcAccounts?.parent && 'parent'].filter(Boolean).join('+') || 'none',
    'sfmcPerm:', sfmcPermission,
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
