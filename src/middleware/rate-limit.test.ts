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

// rate-limit.ts derives the client key from the Bun socket peer (getConnInfo),
// not from x-forwarded-for (config.rateLimit.trustProxy defaults to false). The
// in-process `app.request` has no server, so provide a fake one via the Env slot.
function envFor(ip: string): { server: { requestIP: () => { address: string; family: string; port: number } } } {
  return { server: { requestIP: () => ({ address: ip, family: 'IPv4', port: 1234 }) } }
}

describe('rateLimitMiddleware', () => {
  // Each test uses a distinct peer address, so the module-level store cannot
  // leak counters between tests.
  test(`allows ${MAX} requests per window from one IP, then 429s`, async () => {
    const app = appWithMiddleware()
    const ip = '1.2.3.4'
    const env = envFor(ip)

    for (let i = 0; i < MAX; i++) {
      const res = await app.request('/x', undefined, env)
      if (res.status !== 200) {
        throw new Error(`request ${i + 1} of ${MAX} was rejected with ${res.status}`)
      }
    }

    const blocked = await app.request('/x', undefined, env)
    expect(blocked.status).toBe(429)
    expect(await blocked.json()).toEqual({ error: 'Rate limit exceeded' })
  })

  test('a different IP is not affected by another IP exhausted limit', async () => {
    const app = appWithMiddleware()

    const res = await app.request('/x', undefined, envFor('5.6.7.8'))

    expect(res.status).toBe(200)
    expect(await res.text()).toBe('ok')
  })

  test('ignores spoofable x-forwarded-for when no proxy is trusted', async () => {
    const app = appWithMiddleware()

    // '1.2.3.4' is already exhausted in the test above; a spoofed header must
    // not borrow another client's bucket.
    const res = await app.request('/x', { headers: { 'x-forwarded-for': '1.2.3.4' } }, envFor('9.9.9.9'))

    expect(res.status).toBe(200)
  })
})
