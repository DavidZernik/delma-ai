// Shared high-level SFMC operations used by both /api/projects/:id/*
// routes (Supabase-authed) and /api/local/* routes (local-mode). The
// HTTP layer handles auth + where to fetch credentials; this module is
// pure: account-in, result-out.
//
// Every function here takes an already-resolved SFMC account object
// ({ client_id, client_secret, auth_base_url, rest_base_url, ... }).
// They do NOT read from Supabase, local config, or env vars directly.

import * as sfmcClient from './sfmc-client.js'
import { assemble207, validate207 } from './sfmc-email-assembly.js'
import { BASE_TEMPLATE } from '../email-library/index.js'

// Lazy token cache per-account. The sfmc-client already caches OAuth
// tokens internally (keyed by client_id), so we piggyback on that rather
// than caching here. `fetchAccessToken` below is just the thin shim.
async function fetchAccessToken(acct) {
  const res = await fetch(`${acct.auth_base_url}/v2/token`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      grant_type: 'client_credentials',
      client_id: acct.client_id,
      client_secret: acct.client_secret,
      ...(acct.account_id ? { account_id: acct.account_id } : {})
    })
  })
  if (!res.ok) throw new Error(`token fetch failed: HTTP ${res.status}`)
  const data = await res.json()
  if (!data.access_token) throw new Error('token response missing access_token')
  return data.access_token
}

// List Content Builder folders (categories) for the folder-picker step
// of the email builder. Returns an array of category records as SFMC
// returns them — `{ id, name, parentId, categoryType, ... }`.
export async function listEmailFolders(acct) {
  const token = await fetchAccessToken(acct)
  const res = await fetch(`${acct.rest_base_url}/asset/v1/content/categories?$pagesize=200`, {
    headers: { Authorization: `Bearer ${token}` }
  })
  if (!res.ok) throw new Error(`folders fetch failed: HTTP ${res.status}`)
  const data = await res.json()
  return data.items || []
}

// Resolve a template customerKey to its asset ID. The base email template
// is referenced by customerKey (stable) but the SFMC 207 payload requires
// the numeric asset ID. Every email create needs this lookup.
export async function resolveTemplateId(acct, customerKey) {
  const token = await fetchAccessToken(acct)
  const res = await fetch(`${acct.rest_base_url}/asset/v1/content/assets/query`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ query: { property: 'customerKey', simpleOperator: 'equals', value: customerKey } })
  })
  if (!res.ok) throw new Error(`template lookup failed: HTTP ${res.status}`)
  const data = await res.json()
  return data.items?.[0]?.id || null
}

// Full create-email flow: assemble payload, validate, POST to SFMC.
// Throws on any step's failure with a readable message the HTTP layer
// turns into a 400/502. Returns { assetId, customerKey } on success.
export async function createEmail(acct, {
  name, customerKey, subject, preheader, categoryId, templateKey, blocks
}) {
  if (!name || !subject || !categoryId || !Array.isArray(blocks) || !blocks.length) {
    throw new Error('name, subject, categoryId, blocks[] all required')
  }
  const resolvedTemplateKey = templateKey || BASE_TEMPLATE.id
  const templateId = await resolveTemplateId(acct, resolvedTemplateKey)
  if (!templateId) {
    throw new Error(`template "${resolvedTemplateKey}" not found — run scripts/upload-base-template.js`)
  }

  const payload = assemble207({
    name, customerKey, subject, preheader, categoryId, templateId, blocks
  })
  const validation = validate207(payload)
  if (!validation.ok) {
    const err = new Error('validation failed')
    err.details = validation.errors
    throw err
  }
  const result = await sfmcClient.createEmailAsset(acct, payload)
  if (!result.ok) {
    throw new Error(`SFMC rejected: ${result.code} — ${result.message}`)
  }
  return { assetId: result.assetId, customerKey: result.customerKey }
}
