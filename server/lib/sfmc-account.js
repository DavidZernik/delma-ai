// Loader for the per-org SFMC account row. Returns decrypted creds + safe
// metadata, or null if the org hasn't connected SFMC yet. Used by the chat
// to inject creds into the Agent SDK subprocess as env vars.

import { createClient } from '@supabase/supabase-js'
import { decrypt } from './crypto.js'

let __sb = null
function getSb() {
  if (__sb) return __sb
  if (!process.env.SUPABASE_URL || !process.env.SUPABASE_SERVICE_ROLE_KEY) return null
  __sb = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY, {
    auth: { autoRefreshToken: false, persistSession: false }
  })
  return __sb
}

function rowToAccount(data) {
  if (!data) return null
  return {
    id: data.id,
    bu_role: data.bu_role || 'child',
    label: data.account_label,
    auth_base_url: data.auth_base_url,
    rest_base_url: data.rest_base_url,
    soap_base_url: data.soap_base_url,
    is_sandbox: data.is_sandbox,
    account_id: data.account_id,
    client_id: decrypt(data.client_id_enc),
    client_secret: decrypt(data.client_secret_enc),
    access_token: data.access_token_enc ? decrypt(data.access_token_enc) : null,
    refresh_token: data.refresh_token_enc ? decrypt(data.refresh_token_enc) : null,
    access_expires_at: data.access_expires_at
  }
}

// Returns a map { child: {...}, parent: {...} } — only includes roles that
// are actually configured. Empty object if nothing connected.
export async function getSfmcAccountsForOrg(orgId) {
  const sb = getSb()
  if (!sb || !orgId) return {}
  const { data, error } = await sb
    .from('sfmc_accounts')
    .select('*')
    .eq('org_id', orgId)
  if (error || !data) return {}
  const out = {}
  for (const row of data) {
    const acct = rowToAccount(row)
    if (acct) out[acct.bu_role] = acct
  }
  return out
}

// Backwards-compatible single-account lookup. Prefers child (the default for
// sends), falls back to parent. Used where only one set of creds is needed.
export async function getSfmcAccountForOrg(orgId) {
  const all = await getSfmcAccountsForOrg(orgId)
  return all.child || all.parent || null
}
