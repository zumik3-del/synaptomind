import type { Context, Next } from 'hono'
import { config } from '../../config'

const rateLimitStore = new Map<string, { count: number; resetAt: number }>()
const RATE_LIMIT_MAX = config.rateLimit.max
const RATE_LIMIT_DISABLED = RATE_LIMIT_MAX === 0
const RATE_LIMIT_WINDOW_MS = config.rateLimit.windowMs

function rateLimit(ip: string): boolean {
  const now = Date.now()
  const entry = rateLimitStore.get(ip)
  if (!entry || now > entry.resetAt) {
    rateLimitStore.set(ip, { count: 1, resetAt: now + RATE_LIMIT_WINDOW_MS })
    return true
  }
  entry.count++
  return entry.count <= RATE_LIMIT_MAX
}

setInterval(() => {
  const now = Date.now()
  for (const [ip, entry] of rateLimitStore) {
    if (now > entry.resetAt) rateLimitStore.delete(ip)
  }
}, 60_000)

export async function rateLimitMiddleware(c: Context, next: Next) {
  if (RATE_LIMIT_DISABLED) return next()
  const ip = c.req.header('x-forwarded-for') || c.req.header('x-real-ip') || 'unknown'
  if (!rateLimit(ip)) {
    return c.json({ error: 'Rate limit exceeded' }, 429)
  }
  return next()
}
