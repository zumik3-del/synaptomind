import { describe, expect, test } from 'bun:test'
import { Hono } from 'hono'
import { config } from '../config'
import { rateLimitMiddleware } from './rate-limit'

// rate-limit.ts captures the max in a module constant at import time — read it
// from the same config object here instead of hard-coding 200.
const MAX = config.rateLimit.max

function appWithMiddleware(): Hono {
  const app = new Hono()
  app.use('*', (c, next) => rateLimitMiddleware(c, next))
  app.get('/x', c => c.text('ok'))
  return app
}

describe('rateLimitMiddleware', () => {
  // The store is module-level and shared across the whole test process; no
  // other suite sends x-forwarded-for '1.2.3.4', so the exact boundary is safe.
  test(`allows ${MAX} requests per window from one IP, then 429s`, async () => {
    const app = appWithMiddleware()
    const ip = '1.2.3.4'

    for (let i = 0; i < MAX; i++) {
      const res = await app.request('/x', { headers: { 'x-forwarded-for': ip } })
      if (res.status !== 200) {
        throw new Error(`request ${i + 1} of ${MAX} was rejected with ${res.status}`)
      }
    }

    const blocked = await app.request('/x', { headers: { 'x-forwarded-for': ip } })
    expect(blocked.status).toBe(429)
    expect(await blocked.json()).toEqual({ error: 'Rate limit exceeded' })
  })

  test('a different IP is not affected by another IP exhausted limit', async () => {
    const app = appWithMiddleware()

    const res = await app.request('/x', { headers: { 'x-forwarded-for': '5.6.7.8' } })

    expect(res.status).toBe(200)
    expect(await res.text()).toBe('ok')
  })
})
