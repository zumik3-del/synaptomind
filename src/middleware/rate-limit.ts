import type { Context, Next } from 'hono'
import { getConnInfo } from 'hono/bun'
import { config } from '../config'

interface RateLimitEntry {
  count: number
  resetAt: number
}

const RATE_LIMIT_MAX = config.rateLimit.max
const RATE_LIMIT_DISABLED = RATE_LIMIT_MAX === 0
const RATE_LIMIT_WINDOW_MS = config.rateLimit.windowMs
const TRUST_PROXY = config.rateLimit.trustProxy

// Hard cap on distinct client keys per store. Keys are attacker-influenced when
// a proxy is trusted, so a store must never grow without bound.
const MAX_TRACKED_KEYS = 10_000

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

// Each middleware instance owns an independent counter store. API (:3005) and
// MCP (:3006) share one process but must not contend for the same quota, so
// they get one instance each. Limits stay config-driven (see config.rateLimit).
export function createRateLimitMiddleware() {
  const store = new Map<string, RateLimitEntry>()

  function evictOldestKey(): void {
    const oldest = store.keys().next().value
    if (oldest !== undefined) store.delete(oldest)
  }

  function rateLimit(key: string): boolean {
    const now = Date.now()
    const entry = store.get(key)
    if (!entry || now > entry.resetAt) {
      if (store.size >= MAX_TRACKED_KEYS) evictOldestKey()
      store.set(key, { count: 1, resetAt: now + RATE_LIMIT_WINDOW_MS })
      return true
    }
    entry.count++
    return entry.count <= RATE_LIMIT_MAX
  }

  setInterval(() => {
    const now = Date.now()
    for (const [key, entry] of store) {
      if (now > entry.resetAt) store.delete(key)
    }
  }, 60_000).unref()

  return async (c: Context, next: Next) => {
    if (RATE_LIMIT_DISABLED) return next()
    const key = clientIdentity(c)
    if (!rateLimit(key)) {
      return c.json({ error: 'Rate limit exceeded' }, 429)
    }
    return next()
  }
}

// Protocol-scoped instances: exhausting the API quota leaves MCP untouched and
// vice versa.
export const apiRateLimitMiddleware = createRateLimitMiddleware()
export const mcpRateLimitMiddleware = createRateLimitMiddleware()
