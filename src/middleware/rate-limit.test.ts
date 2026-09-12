import { describe, expect, jest, test } from 'bun:test'
import { Hono } from 'hono'
import { config } from '../config'
import { apiRateLimitMiddleware, createRateLimitMiddleware, mcpRateLimitMiddleware } from './rate-limit'

// rate-limit.ts captures the max in a module constant at import time — read it
// from the same config object here instead of hard-coding 200.
const MAX = config.rateLimit.max

// Mirrors the private MAX_TRACKED_KEYS constant in rate-limit.ts; the store is
// not exported, so the cap must be mirrored here to drive it to its limit.
const CAP = 10_000

type RateLimitMiddleware = ReturnType<typeof createRateLimitMiddleware>

function appFor(middleware: RateLimitMiddleware): Hono {
  const app = new Hono()
  app.use('*', (c, next) => middleware(c, next))
  app.get('/x', c => c.text('ok'))
  return app
}

function appWithMiddleware(): Hono {
  return appFor(apiRateLimitMiddleware)
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

describe('createRateLimitMiddleware — per-instance isolation', () => {
  test('two fresh factory instances with the same peer IP have independent quotas', async () => {
    const appA = appFor(createRateLimitMiddleware())
    const appB = appFor(createRateLimitMiddleware())
    const env = envFor('198.18.0.1')

    // Exhaust instance A's quota for this peer.
    for (let i = 0; i < MAX; i++) {
      const res = await appA.request('/x', undefined, env)
      if (res.status !== 200) {
        throw new Error(`instance A request ${i + 1} of ${MAX} rejected with ${res.status}`)
      }
    }
    expect((await appA.request('/x', undefined, env)).status).toBe(429)

    // Instance B must still have its full quota for the same peer IP.
    const allowed = await appB.request('/x', undefined, env)
    expect(allowed.status).toBe(200)
    expect(await allowed.text()).toBe('ok')
  })

  test('api and mcp export instances do not share state', async () => {
    const api = appFor(apiRateLimitMiddleware)
    const mcp = appFor(mcpRateLimitMiddleware)
    const env = envFor('198.18.0.2')

    for (let i = 0; i < MAX; i++) {
      const res = await api.request('/x', undefined, env)
      if (res.status !== 200) {
        throw new Error(`api request ${i + 1} of ${MAX} rejected with ${res.status}`)
      }
    }
    expect((await api.request('/x', undefined, env)).status).toBe(429)

    // Exhausting the API quota must leave the MCP quota untouched.
    const mcpRes = await mcp.request('/x', undefined, env)
    expect(mcpRes.status).toBe(200)
    expect(await mcpRes.text()).toBe('ok')
  })
})

describe('createRateLimitMiddleware — bounded store', () => {
  test('eviction cap drops the oldest key only, keeping the newest tracked', async () => {
    const app = appFor(createRateLimitMiddleware())
    const oldest = '203.0.113.1'
    const oldestEnv = envFor(oldest)

    // Exhaust the first key; the store now holds exactly one entry.
    for (let i = 0; i < MAX; i++) {
      const res = await app.request('/x', undefined, oldestEnv)
      if (res.status !== 200) {
        throw new Error(`oldest request ${i + 1} of ${MAX} rejected with ${res.status}`)
      }
    }
    expect((await app.request('/x', undefined, oldestEnv)).status).toBe(429)

    // Fill the store to the cap with distinct peers (unique 198.51.x.y addresses).
    const filler = (i: number) => `198.51.${Math.floor(i / 250)}.${i % 250}`
    for (let i = 0; i < CAP - 1; i++) {
      const res = await app.request('/x', undefined, envFor(filler(i)))
      if (res.status !== 200) {
        throw new Error(`filler request ${i + 1} of ${CAP - 1} rejected with ${res.status}`)
      }
    }

    // Exhaust the most recently inserted key too, so eviction order is observable.
    const newest = filler(CAP - 2)
    const newestEnv = envFor(newest)
    for (let i = 1; i < MAX; i++) {
      const res = await app.request('/x', undefined, newestEnv)
      if (res.status !== 200) {
        throw new Error(`newest request ${i + 1} of ${MAX} rejected with ${res.status}`)
      }
    }
    expect((await app.request('/x', undefined, newestEnv)).status).toBe(429)

    // One more distinct peer exceeds the cap and evicts the oldest entry.
    expect((await app.request('/x', undefined, envFor('203.0.113.2'))).status).toBe(200)

    // The oldest key was dropped and starts with a fresh quota ...
    expect((await app.request('/x', undefined, oldestEnv)).status).toBe(200)
    // ... while the newest, still-tracked key remains exhausted (FIFO, not LIFO).
    expect((await app.request('/x', undefined, newestEnv)).status).toBe(429)
  })
})

describe('createRateLimitMiddleware — sweeper', () => {
  test('periodic sweeper reclaims expired keys from a single instance', async () => {
    jest.useFakeTimers()
    const originalDelete = Map.prototype.delete
    const swept: string[] = []
    // White-box probe: the store is private, so observe its deletions directly.
    Map.prototype.delete = function (key: unknown): boolean {
      if (typeof key === 'string' && key.startsWith('sweep-')) swept.push(key)
      return originalDelete.call(this, key)
    }
    try {
      const app = appFor(createRateLimitMiddleware())
      await app.request('/x', undefined, envFor('sweep-a'))
      await app.request('/x', undefined, envFor('sweep-b'))
      expect(swept).toEqual([])

      // Ticks land at +60s (== resetAt, strict `>` means no delete) and +120s.
      jest.advanceTimersByTime(120_000)
      expect(swept.sort()).toEqual(['sweep-a', 'sweep-b'])
    } finally {
      Map.prototype.delete = originalDelete
      jest.useRealTimers()
    }
  })
})
