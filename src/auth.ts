import { createHash, timingSafeEqual } from 'node:crypto'

let warnedMissingTokens = false

// Explicit local-development opt-out. Without a configured token and without
// this flag the server fails closed: every authenticated request is rejected.
function isInsecureMode(): boolean {
  return process.env.SYNAPTOMIND_ALLOW_INSECURE === 'true'
}

/**
 * The configured bearer tokens. Resolved on every call (task #2201): the list
 * used to be cached at module level with a test-only hook to refresh it, which
 * left production correct only as long as the env never changed.
 */
export function getValidTokens(): string[] {
  const secret = process.env.SYNAPTOMIND_SECRET || ''
  const serviceToken = process.env.SYNAPTOMIND_SERVICE_TOKEN || secret
  const tokens = [secret, serviceToken].filter(Boolean)

  if (tokens.length === 0 && !isInsecureMode() && !warnedMissingTokens) {
    warnedMissingTokens = true
    console.error('[synaptomind] SECURITY: neither SYNAPTOMIND_SECRET nor SYNAPTOMIND_SERVICE_TOKEN is set.')
    console.error('[synaptomind] Failing closed: authenticated requests will be rejected (401).')
    console.error('[synaptomind] Set a secret, or set SYNAPTOMIND_ALLOW_INSECURE=true for local development only.')
  }

  return tokens
}

export function checkBearerAuth(auth: string | undefined): boolean {
  // Explicit insecure mode bypasses token checks entirely (local dev only).
  if (isInsecureMode()) return true

  const tokens = getValidTokens()
  if (tokens.length === 0) return false

  if (!auth?.startsWith('Bearer ')) return false
  const token = auth.slice('Bearer '.length)
  return tokens.some(t => safeTokenEqual(t, token))
}

// Constant-time comparison: hash both sides so the operands always have the
// same length (timingSafeEqual throws on length mismatch), then compare digests.
function safeTokenEqual(a: string, b: string): boolean {
  const da = createHash('sha256').update(a).digest()
  const db = createHash('sha256').update(b).digest()
  return timingSafeEqual(da, db)
}
