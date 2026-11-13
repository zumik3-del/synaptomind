import { createHash, timingSafeEqual } from 'node:crypto'
import { config, hashUserToken } from './config'

let warnedMissingTokens = false
let warnedInertSecret = false
let warnedInsecureWithUsers = false

function isInsecureMode(): boolean {
  return process.env.SYNAPTOMIND_ALLOW_INSECURE === 'true'
}

export type UserKind = 'user' | 'legacy'

export interface UserRef {
  userId: string
  kind: UserKind
}

export function getValidTokens(): string[] {
  const users = Array.isArray(config.users) ? config.users : []

  if (users.length > 0) {
    if (!warnedInertSecret && process.env.SYNAPTOMIND_SECRET) {
      warnedInertSecret = true
      console.error(
        '[synaptomind] SECURITY: SYNAPTOMIND_SECRET is inert because users are configured; legacy token ignored.'
      )
    }
    if (isInsecureMode() && !warnedInsecureWithUsers) {
      warnedInsecureWithUsers = true
      console.error(
        '[synaptomind] SECURITY: SYNAPTOMIND_ALLOW_INSECURE is ignored because users are configured.'
      )
    }
    return []
  }

  const secret = process.env.SYNAPTOMIND_SECRET || ''
  const tokens = secret ? [secret] : []

  if (tokens.length === 0 && !isInsecureMode() && !warnedMissingTokens) {
    warnedMissingTokens = true
    console.error('[synaptomind] SECURITY: SYNAPTOMIND_SECRET is not set.')
    console.error('[synaptomind] Failing closed: authenticated requests will be rejected (401).')
    console.error(
      '[synaptomind] Set a secret, or set SYNAPTOMIND_ALLOW_INSECURE=true for local development only.'
    )
  }

  return tokens
}

export function resolveUser(auth: string | undefined): UserRef | null {
  const users = Array.isArray(config.users) ? config.users : []

  if (users.length === 0 && isInsecureMode()) {
    return { userId: 'legacy', kind: 'legacy' }
  }

  if (!auth?.startsWith('Bearer ')) return null

  const token = auth.slice('Bearer '.length)
  const presented = token

  let matchedUserId: string | null = null
  for (const entry of users) {
    if (safeTokenEqual(String(entry?.tokenSha256 ?? ''), hashUserToken(presented))) {
      matchedUserId = entry.id
    }
  }
  if (matchedUserId !== null) {
    return { userId: matchedUserId, kind: 'user' }
  }

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

// Both sides are hashed first: `timingSafeEqual` throws on a length mismatch, which would turn a
// malformed stored digest into a 500 instead of a 401.
function safeTokenEqual(a: string, b: string): boolean {
  const da = createHash('sha256').update(a).digest()
  const db = createHash('sha256').update(b).digest()
  return timingSafeEqual(da, db)
}
