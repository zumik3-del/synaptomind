import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { Hono } from 'hono'
import { authMiddleware } from './auth'

const ROOT = join(import.meta.dir, '..', '..')

function readSource(relative: string): string {
  return readFileSync(join(ROOT, relative), 'utf8')
}

describe('shared auth middleware (F19 architectural guard)', () => {
  test('the duplicated API-local auth middleware file no longer exists', () => {
    expect(existsSync(join(ROOT, 'src/api/middleware/auth.ts'))).toBe(false)
  })

  test('the guarded pipeline is the one place the shared auth middleware is mounted', () => {
    expect(readSource('src/middleware/guarded-pipeline.ts')).toContain("from './auth'")
    expect(readSource('src/api/router.ts')).toContain('createGuardedPipeline')
    expect(readSource('src/mcp/http-transport.ts')).toContain('createGuardedPipeline')
  })

  test('neither HTTP surface defines its own auth middleware', () => {
    expect(readSource('src/api/router.ts')).not.toContain('function authMiddleware')
    expect(readSource('src/mcp/http-transport.ts')).not.toContain('function authMiddleware')
  })
})

describe('shared auth middleware behaviour', () => {
  const SECRET = 'shared-auth-middleware-test-secret'
  const previous: Record<string, string | undefined> = {}

  beforeAll(() => {
    for (const key of ['SYNAPTOMIND_SECRET', 'SYNAPTOMIND_ALLOW_INSECURE']) {
      previous[key] = process.env[key]
    }
    process.env.SYNAPTOMIND_SECRET = SECRET
    delete process.env.SYNAPTOMIND_ALLOW_INSECURE
  })

  afterAll(() => {
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[key]
      else process.env[key] = value
    }
  })

  function guardedApp(): Hono {
    const app = new Hono()
    app.use('/api/*', authMiddleware)
    app.get('/api/x', c => c.text('ok'))
    return app
  }

  test('a valid bearer token passes through', async () => {
    const res = await guardedApp().request('/api/x', {
      headers: { authorization: `Bearer ${SECRET}` }
    })
    expect(res.status).toBe(200)
    expect(await res.text()).toBe('ok')
  })

  test('a missing token is rejected with the standard 401 JSON envelope', async () => {
    const res = await guardedApp().request('/api/x')
    expect(res.status).toBe(401)
    expect(await res.json()).toEqual({ error: 'Unauthorized' })
  })

  test('an invalid token is rejected with 401', async () => {
    const res = await guardedApp().request('/api/x', {
      headers: { authorization: 'Bearer not-the-secret' }
    })
    expect(res.status).toBe(401)
  })
})
