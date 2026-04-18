// AES-256-GCM symmetric encryption for at-rest secrets (SFMC client_secret,
// access_token, refresh_token). Key is a 64-char hex string in the
// DELMA_CRYPTO_KEY env var. Output is a self-contained string:
// "v1:<iv-hex>:<authTag-hex>:<ciphertext-hex>" — version-prefixed so we
// can rotate algorithms later without losing existing rows.
//
// Stored in Postgres as `text`, not `bytea`, so we can ditch the pgcrypto
// helpers in 017_sfmc_credentials.sql (those depend on a Postgres setting
// Supabase managed DBs don't allow setting).

import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto'

const ALGO = 'aes-256-gcm'

function getKey() {
  const hex = process.env.DELMA_CRYPTO_KEY
  if (!hex) throw new Error('DELMA_CRYPTO_KEY not set')
  if (hex.length !== 64) throw new Error('DELMA_CRYPTO_KEY must be 64 hex chars (32 bytes)')
  return Buffer.from(hex, 'hex')
}

export function encrypt(plain) {
  if (plain == null) return null
  const key = getKey()
  const iv = randomBytes(12) // GCM standard
  const cipher = createCipheriv(ALGO, key, iv)
  const ct = Buffer.concat([cipher.update(String(plain), 'utf8'), cipher.final()])
  const tag = cipher.getAuthTag()
  return `v1:${iv.toString('hex')}:${tag.toString('hex')}:${ct.toString('hex')}`
}

export function decrypt(payload) {
  if (!payload) return null
  const parts = payload.split(':')
  if (parts[0] !== 'v1' || parts.length !== 4) {
    throw new Error('encrypted payload format unrecognized')
  }
  const [, ivHex, tagHex, ctHex] = parts
  const key = getKey()
  const decipher = createDecipheriv(ALGO, key, Buffer.from(ivHex, 'hex'))
  decipher.setAuthTag(Buffer.from(tagHex, 'hex'))
  const pt = Buffer.concat([
    decipher.update(Buffer.from(ctHex, 'hex')),
    decipher.final()
  ])
  return pt.toString('utf8')
}
