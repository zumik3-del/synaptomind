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

const MAX_TRACKED_KEYS = 10_000

function clientIdentity(c: Context): string {
  if (TRUST_PROXY) {
    const forwarded = c.req.header('x-forwarded-for')
    if (forwarded) {
      const hops = forwarded
        .split(',')
        .map(h => h.trim())
        .filter(Boolean)
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
    return undefined
  }
}

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
    store.delete(key)
    entry.count++
    store.set(key, entry)
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
