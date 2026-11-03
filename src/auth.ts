import { createHash, timingSafeEqual } from 'node:crypto'
import { config, hashUserToken } from './config'

let warnedMissingTokens = false
let warnedInertSecret = false
let warnedInsecureWithUsers = false

// Explicit local-development opt-out. Without a configured token and without
// this flag the server fails closed: every authenticated request is rejected.
function isInsecureMode(): boolean {
  return process.env.SYNAPTOMIND_ALLOW_INSECURE === 'true'
}

export type UserKind = 'user' | 'legacy'

export interface UserRef {
  userId: string
  kind: UserKind
}

/**
 * The configured bearer tokens. Resolved on every call (task #2201): the list
 * used to be cached at module level with a test-only hook to refresh it, which
 * left production correct only as long as the env never changed.
 *
 * Legacy tokens are inert once `users` is configured (grilling decision 1):
 * `SYNAPTOMIND_SECRET` resolves only in single-user mode. `SYNAPTOMIND_SERVICE_TOKEN`
 * is dropped entirely.
 */
export function getValidTokens(): string[] {
  const users = Array.isArray(config.users) ? config.users : []

  if (users.length > 0) {
    if (!warnedInertSecret && process.env.SYNAPTOMIND_SECRET) {
      warnedInertSecret = true
      console.error('[synaptomind] SECURITY: SYNAPTOMIND_SECRET is inert because users are configured; legacy token ignored.')
    }
    if (isInsecureMode() && !warnedInsecureWithUsers) {
      warnedInsecureWithUsers = true
      console.error('[synaptomind] SECURITY: SYNAPTOMIND_ALLOW_INSECURE is ignored because users are configured.')
    }
    return []
  }

  const secret = process.env.SYNAPTOMIND_SECRET || ''
  const tokens = secret ? [secret] : []

  if (tokens.length === 0 && !isInsecureMode() && !warnedMissingTokens) {
    warnedMissingTokens = true
    console.error('[synaptomind] SECURITY: SYNAPTOMIND_SECRET is not set.')
    console.error('[synaptomind] Failing closed: authenticated requests will be rejected (401).')
    console.error('[synaptomind] Set a secret, or set SYNAPTOMIND_ALLOW_INSECURE=true for local development only.')
  }

  return tokens
}

export function resolveUser(auth: string | undefined): UserRef | null {
  const users = Array.isArray(config.users) ? config.users : []

  // Insecure mode is only a single-user legacy bypass.
  if (users.length === 0 && isInsecureMode()) {
    return { userId: 'legacy', kind: 'legacy' }
  }

  if (!auth?.startsWith('Bearer ')) return null

  const token = auth.slice('Bearer '.length)
  const presented = token
  
  // Configured users: match by token hash (evaluate every entry, no short-circuit).
  // Hash the stored digest and the presented token's hash through safeTokenEqual so
  // a malformed (non-hex / wrong-length) digest compares as a normal mismatch and
  // yields 401 instead of throwing (timingSafeEqual throws on length mismatch).
  let matchedUserId: string | null = null
  for (const entry of users) {
    if (safeTokenEqual(String(entry?.tokenSha256 ?? ''), hashUserToken(presented))) {
      matchedUserId = entry.id
    }
  }
  if (matchedUserId !== null) {
    return { userId: matchedUserId, kind: 'user' }
  }

  // Legacy single-user mode: compare against legacy tokens (no short-circuit).
  if (users.length === 0) {
    const tokens = getValidTokens()
    let ok = false
    for (const t of tokens) {
      if (safeTokenEqual(t, token)) ok = true
    }
    if (ok) return { userId: 'legacy', kind: 'legacy' }
  }

  return null
}

export function checkBearerAuth(auth: string | undefined): boolean {
  return resolveUser(auth) !== null
}

// Constant-time comparison: hash both sides so the operands always have the
// same length (timingSafeEqual throws on length mismatch), then compare digests.
function safeTokenEqual(a: string, b: string): boolean {
  const da = createHash('sha256').update(a).digest()
  const db = createHash('sha256').update(b).digest()
  return timingSafeEqual(da, db)
}
