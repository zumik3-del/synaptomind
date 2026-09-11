import { createHash, timingSafeEqual } from 'node:crypto'

let validTokens: string[] | null = null
let warnedMissingTokens = false

// Test hook: drop the cached token list so env changes are re-read.
export function resetValidTokens(): void {
  validTokens = null
}

// Explicit local-development opt-out. Without a configured token and without
// this flag the server fails closed: every authenticated request is rejected.
export function isInsecureMode(): boolean {
  return process.env.SYNAPTOMIND_ALLOW_INSECURE === 'true'
}

export function getValidTokens(): string[] {
  if (validTokens) return validTokens

  const secret = process.env.SYNAPTOMIND_SECRET || ''
  const serviceToken = process.env.SYNAPTOMIND_SERVICE_TOKEN || secret
  validTokens = [secret, serviceToken].filter(Boolean)

  if (validTokens.length === 0 && !isInsecureMode() && !warnedMissingTokens) {
    warnedMissingTokens = true
    console.error('[synaptomind] SECURITY: neither SYNAPTOMIND_SECRET nor SYNAPTOMIND_SERVICE_TOKEN is set.')
    console.error('[synaptomind] Failing closed: authenticated requests will be rejected (401).')
    console.error('[synaptomind] Set a secret, or set SYNAPTOMIND_ALLOW_INSECURE=true for local development only.')
  }

  return validTokens
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
