import type { Context, Next } from 'hono'
import { getConnInfo } from 'hono/bun'
import { config } from '../config'

const rateLimitStore = new Map<string, { count: number; resetAt: number }>()
const RATE_LIMIT_MAX = config.rateLimit.max
const RATE_LIMIT_DISABLED = RATE_LIMIT_MAX === 0
const RATE_LIMIT_WINDOW_MS = config.rateLimit.windowMs
const TRUST_PROXY = config.rateLimit.trustProxy

// Hard cap on distinct client keys. Keys are attacker-influenced when a proxy
// is trusted, so the store must never grow without bound.
const MAX_TRACKED_KEYS = 10_000

function evictOldestKey(): void {
  const oldest = rateLimitStore.keys().next().value
  if (oldest !== undefined) rateLimitStore.delete(oldest)
}

function rateLimit(key: string): boolean {
  const now = Date.now()
  const entry = rateLimitStore.get(key)
  if (!entry || now > entry.resetAt) {
    if (rateLimitStore.size >= MAX_TRACKED_KEYS) evictOldestKey()
    rateLimitStore.set(key, { count: 1, resetAt: now + RATE_LIMIT_WINDOW_MS })
    return true
  }
  entry.count++
  return entry.count <= RATE_LIMIT_MAX
}

// Only trust proxy headers when explicitly enabled; otherwise the socket peer
// address is authoritative and spoofed x-forwarded-for values are ignored.
// With a trusted proxy, the rightmost hop is the one it appended (the real
// client); left entries are client-controllable.
function clientIdentity(c: Context): string {
  if (TRUST_PROXY) {
    const forwarded = c.req.header('x-forwarded-for')
    if (forwarded) {
      const hops = forwarded.split(',').map(h => h.trim()).filter(Boolean)
      const last = hops[hops.length - 1]
      if (last) return last
    }
    const realIp = c.req.header('x-real-ip')
    if (realIp) return realIp
  }
  return peerAddress(c) ?? 'unknown'
}

function peerAddress(c: Context): string | undefined {
  try {
    return getConnInfo(c).remote.address ?? undefined
  } catch {
    // No Bun server on the context (e.g. in-process `app.request`).
    return undefined
  }
}

setInterval(() => {
  const now = Date.now()
  for (const [ip, entry] of rateLimitStore) {
    if (now > entry.resetAt) rateLimitStore.delete(ip)
  }
}, 60_000).unref()

export async function rateLimitMiddleware(c: Context, next: Next) {
  if (RATE_LIMIT_DISABLED) return next()
  const key = clientIdentity(c)
  if (!rateLimit(key)) {
    return c.json({ error: 'Rate limit exceeded' }, 429)
  }
  return next()
}
