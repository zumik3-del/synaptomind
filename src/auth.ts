import { createHash, timingSafeEqual } from 'node:crypto'

let validTokens: string[] | null = null

// Test hook: drop the cached token list so env changes are re-read.
export function resetValidTokens(): void {
  validTokens = null
}

export function getValidTokens(): string[] {
  if (validTokens) return validTokens

  const secret = process.env.SYNAPTOMIND_SECRET || ''
  const serviceToken = process.env.SYNAPTOMIND_SERVICE_TOKEN || secret
  validTokens = [secret, serviceToken].filter(Boolean)

  if (validTokens.length === 0) {
    const token = crypto.randomUUID()
    console.error(`[synaptomind] No SYNAPTOMIND_SECRET or SYNAPTOMIND_SERVICE_TOKEN set.`)
    console.error(`[synaptomind] Generated token: ${token}`)
    console.error(`[synaptomind] Use: Authorization: Bearer ${token}`)
    validTokens.push(token)
  }

  return validTokens
}

// Constant-time comparison: hash both sides so the operands always have the
// same length (timingSafeEqual throws on length mismatch), then compare digests.
function safeTokenEqual(a: string, b: string): boolean {
  const da = createHash('sha256').update(a).digest()
  const db = createHash('sha256').update(b).digest()
  return timingSafeEqual(da, db)
}

export function checkBearerAuth(auth: string | undefined): boolean {
  if (!auth?.startsWith('Bearer ')) return false
  const token = auth.slice('Bearer '.length)
  return getValidTokens().some(t => safeTokenEqual(t, token))
}
