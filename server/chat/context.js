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

export async function buildChatSystemPrompt({ projectId, orgId, sfmcAccounts }) {
  const [project, org, views, memoryRows, orgMemoryRows] = await Promise.all([
    sb.from('projects').select('id, name').eq('id', projectId).maybeSingle().then(r => r.data),
    sb.from('organizations').select('id, name').eq('id', orgId).maybeSingle().then(r => r.data),
    sb.from('diagram_views').select('view_key, title, description, mermaid').eq('project_id', projectId),
    sb.from('memory_notes').select('filename, content').eq('project_id', projectId),
    sb.from('org_memory_notes').select('filename, content').eq('org_id', orgId)
  ])

  const lines = []
  lines.push(`# Delma — In-app SFMC Operator`)
  lines.push(``)
  lines.push(`You are the in-app collaborator for this SFMC project. You see the project's full state below and act on the user's behalf to inspect, plan, and modify the campaign — including hitting the SFMC API directly via Bash + curl when needed.`)
  lines.push(``)
  lines.push(`**How to behave:**`)
  lines.push(`- Stay grounded in the project context below. Do not ask questions whose answers are already in front of you.`)
  lines.push(`- When the user asks about a piece of the campaign (an email, a journey, a DE), pull the specifics from "Files Locations and Keys" first.`)
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
      lines.push(`- Subdomain: ${(c.rest_base_url || '').match(/^https?:\\/\\/([^.]+)\\./)?.[1] || '(unknown)'}`)
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

  return lines.join('\n')
}
