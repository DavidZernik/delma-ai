// Verify a Supabase access token from the Authorization header and return
// the authenticated user. Throws on failure. Use on every endpoint that
// mutates data — never trust a userId from the request body.

import { createClient } from '@supabase/supabase-js'

export async function requireUser(req) {
  const auth = req.headers?.authorization || req.headers?.Authorization
  if (!auth || !auth.startsWith('Bearer ')) {
    const e = new Error('missing Authorization header')
    e.status = 401
    throw e
  }
  const token = auth.slice('Bearer '.length).trim()
  if (!token) {
    const e = new Error('empty bearer token')
    e.status = 401
    throw e
  }
  if (!process.env.SUPABASE_URL || !process.env.SUPABASE_ANON_KEY) {
    const e = new Error('Supabase env vars missing on server')
    e.status = 500
    throw e
  }
  // Use anon-key client to verify the token (introspects via getUser).
  const sb = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_ANON_KEY, {
    global: { headers: { Authorization: `Bearer ${token}` } },
    auth: { autoRefreshToken: false, persistSession: false }
  })
  const { data, error } = await sb.auth.getUser(token)
  if (error || !data?.user) {
    const e = new Error('invalid or expired token')
    e.status = 401
    throw e
  }
  return data.user
}

// Verify the user is a member of the org or project they're editing.
// Returns true on success, throws 403 on failure.
export async function requireOrgMembership(serviceSb, userId, orgId) {
  const { data, error } = await serviceSb
    .from('org_members')
    .select('role')
    .eq('user_id', userId).eq('org_id', orgId)
    .maybeSingle()
  if (error) throw new Error(`membership check failed: ${error.message}`)
  if (!data) {
    const e = new Error('not a member of this org')
    e.status = 403
    throw e
  }
  return data.role
}

export async function requireProjectMembership(serviceSb, userId, projectId) {
  const { data, error } = await serviceSb
    .from('project_members')
    .select('role')
    .eq('user_id', userId).eq('project_id', projectId)
    .maybeSingle()
  if (error) throw new Error(`membership check failed: ${error.message}`)
  if (!data) {
    const e = new Error('not a member of this project')
    e.status = 403
    throw e
  }
  return data.role
}
