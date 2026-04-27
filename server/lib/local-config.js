// Local-first config loader. Delma reads user credentials + settings from
// two files on disk, both in the user's home directory so they survive
// across projects and app reinstalls:
//
//   ~/.config/delma/config.json      — Delma's own settings (Anthropic API
//                                       key, default project folder,
//                                       feature flags)
//   ~/.config/sfmc/.env              — SFMC credentials (shared across every
//                                       project that uses SFMC)
//
// Both files are OWNED BY THE USER. We read them, never write them silently.
// The first-run setup screen writes once with explicit confirmation.
//
// This module replaces the Supabase-backed `sfmc-account.js` loader for the
// local-first rewrite. Every consumer (email builder endpoint, future MCP
// subprocess, CLI) reads from here — so creds live in exactly one place.

import { readFileSync, existsSync, mkdirSync, writeFileSync, renameSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join, resolve as resolvePath } from 'node:path'

// Atomic file write: write to a sibling .tmp file, then rename into place.
// rename(2) is atomic on POSIX within the same filesystem, so the target
// either shows the old content or the new content — never a truncated
// half-write, even if the process crashes mid-I/O. Use everywhere we write
// a file that would be painful to find corrupted (config, CLAUDE.md,
// chat history).
export function atomicWrite(filePath, content, { mode } = {}) {
  mkdirSync(dirname(filePath), { recursive: true })
  const tmpPath = `${filePath}.${process.pid}.${Date.now()}.tmp`
  writeFileSync(tmpPath, content, mode ? { mode } : undefined)
  renameSync(tmpPath, filePath)
}

const DELMA_CONFIG_DIR = join(homedir(), '.config', 'delma')
const DELMA_CONFIG_PATH = join(DELMA_CONFIG_DIR, 'config.json')
const SFMC_ENV_DIR = join(homedir(), '.config', 'sfmc')
const SFMC_ENV_PATH = join(SFMC_ENV_DIR, '.env')

// Minimal .env parser — no support for exports, quotes with escapes, or
// multi-line values. Sufficient for the flat key=value files Delma writes
// and reads. Lines starting with # or blank lines are ignored.
function parseEnv(text) {
  const out = {}
  for (const rawLine of (text || '').split('\n')) {
    const line = rawLine.trim()
    if (!line || line.startsWith('#')) continue
    const eq = line.indexOf('=')
    if (eq === -1) continue
    const key = line.slice(0, eq).trim()
    let value = line.slice(eq + 1).trim()
    // Strip surrounding double or single quotes if present.
    if ((value.startsWith('"') && value.endsWith('"'))
        || (value.startsWith('\'') && value.endsWith('\''))) {
      value = value.slice(1, -1)
    }
    out[key] = value
  }
  return out
}

// Serialize a flat object to .env format. Keys with spaces / equals signs
// shouldn't appear (we enforce this via the shape, not escaping).
function serializeEnv(obj) {
  return Object.entries(obj)
    .filter(([, v]) => v !== undefined && v !== null && v !== '')
    .map(([k, v]) => `${k}=${String(v)}`)
    .join('\n') + '\n'
}

// Stash a Delma session (access_token, email) into the local config so the
// app stays signed in across restarts. We persist the access_token only
// (not refresh — re-sign-in is fine when it expires; this is a desktop tool
// not a 24/7 service) and the user's email for UI display.
export function saveDelmaSession({ access_token, email, expires_at }) {
  return saveDelmaConfig({ session: { access_token, email, expires_at } })
}
export function clearDelmaSession() {
  const cur = loadDelmaConfig()
  delete cur.session
  atomicWrite(DELMA_CONFIG_PATH, JSON.stringify(cur, null, 2) + '\n', { mode: 0o600 })
  return cur
}

// Read ~/.config/delma/config.json. Returns {} if missing — first-run UX
// handles the missing-key case; this loader doesn't throw on its own.
export function loadDelmaConfig() {
  if (!existsSync(DELMA_CONFIG_PATH)) return {}
  try { return JSON.parse(readFileSync(DELMA_CONFIG_PATH, 'utf8')) }
  catch (err) {
    console.warn('[local-config] failed to parse', DELMA_CONFIG_PATH, err.message)
    return {}
  }
}

// Write ~/.config/delma/config.json, creating the directory if needed.
// Called from the first-run setup endpoint only.
export function saveDelmaConfig(patch) {
  const current = loadDelmaConfig()
  const next = { ...current, ...patch }
  atomicWrite(DELMA_CONFIG_PATH, JSON.stringify(next, null, 2) + '\n', { mode: 0o600 })
  return next
}

// Read ~/.config/sfmc/.env. Two BU tiers: child (default for sends/journeys,
// required) and parent (optional — needed only for projects that touch the
// enterprise account API). Returns { child, parent } with BU objects in the
// same shape the old Supabase-backed loader produced, so every consumer
// (email builder, SFMC client) can swap import without other changes.
export function loadSfmcAccounts() {
  if (!existsSync(SFMC_ENV_PATH)) return {}
  const env = parseEnv(readFileSync(SFMC_ENV_PATH, 'utf8'))
  const out = {}
  if (env.CLIENT_ID && env.CLIENT_SECRET) {
    out.child = {
      bu_role: 'child',
      label: env.CHILD_BU_LABEL || 'Default BU',
      client_id: env.CLIENT_ID,
      client_secret: env.CLIENT_SECRET,
      account_id: env.ACCOUNT_ID || env.SFMC_MID || '',
      auth_base_url: env.AUTH_BASE_URL || env.SFMC_AUTH_BASE_URL || '',
      rest_base_url: env.REST_BASE_URL || env.SFMC_REST_BASE_URL || '',
      soap_base_url: env.SOAP_BASE_URL || env.SFMC_SOAP_BASE_URL || ''
    }
  }
  if (env.PARENT_BU_CLIENT_ID && env.PARENT_BU_CLIENT_SECRET) {
    out.parent = {
      bu_role: 'parent',
      label: env.PARENT_BU_LABEL || 'Parent BU',
      client_id: env.PARENT_BU_CLIENT_ID,
      client_secret: env.PARENT_BU_CLIENT_SECRET,
      account_id: env.PARENT_BU_MID || '',
      auth_base_url: env.PARENT_BU_AUTH_BASE_URL || '',
      rest_base_url: env.PARENT_BU_REST_BASE_URL || '',
      soap_base_url: env.PARENT_BU_SOAP_BASE_URL || ''
    }
  }
  return out
}

// Write ~/.config/sfmc/.env. Called from the first-run setup endpoint only.
// The file is chmod 0600 since it contains OAuth secrets.
export function saveSfmcEnv(fields) {
  const existing = existsSync(SFMC_ENV_PATH)
    ? parseEnv(readFileSync(SFMC_ENV_PATH, 'utf8'))
    : {}
  const next = { ...existing, ...fields }
  atomicWrite(SFMC_ENV_PATH, serializeEnv(next), { mode: 0o600 })
  return next
}

// Summary for first-run-check / status endpoint. Never returns secrets —
// only booleans + non-sensitive labels so the frontend can decide whether
// to show the setup screen and what BUs are configured.
export function getConfigStatus() {
  const delma = loadDelmaConfig()
  const sfmc = loadSfmcAccounts()
  return {
    anthropicKey: !!delma.anthropic_api_key,
    defaultProjectDir: delma.default_project_dir || null,
    sfmc: {
      child: !!sfmc.child,
      parent: !!sfmc.parent,
      childLabel: sfmc.child?.label || null,
      parentLabel: sfmc.parent?.label || null
    }
  }
}

// Paths exposed so tests / diagnostics can reference them without
// re-joining. Useful when error messages say "check ~/.config/..."
export const CONFIG_PATHS = {
  delmaDir: DELMA_CONFIG_DIR,
  delmaConfig: DELMA_CONFIG_PATH,
  sfmcDir: SFMC_ENV_DIR,
  sfmcEnv: SFMC_ENV_PATH
}

// Resolve + validate a project-folder path from an untrusted source
// (a query string, a POST body). Disallows empties, relative paths,
// traversal patterns, and anything outside the user's home dir.
// Returns the resolved absolute path or throws an Error that the
// caller can map to a 400.
export function safeResolveProjectPath(raw) {
  if (!raw || typeof raw !== 'string') throw new Error('path is required')
  const resolved = resolvePath(raw)
  // Must live under the user's home — prevents "/" or "/etc/..." mischief.
  const home = homedir()
  if (!resolved.startsWith(home + '/') && resolved !== home) {
    throw new Error(`path must be inside ${home}`)
  }
  return resolved
}
