import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { Hono } from 'hono'
import { resetValidTokens } from '../auth'
import { authMiddleware } from './auth'

// Coverage for task #170 finding F19: the API and the MCP HTTP transport must
// share one bearer-auth middleware, so the wire contract cannot drift between
// protocols. The guard is partly architectural: the old API-local copy must
// stay deleted, and both entrypoints must import the shared module.

const ROOT = join(import.meta.dir, '..', '..')

function readSource(relative: string): string {
  return readFileSync(join(ROOT, relative), 'utf8')
}

describe('shared auth middleware (F19 architectural guard)', () => {
  test('the duplicated API-local auth middleware file no longer exists', () => {
    expect(existsSync(join(ROOT, 'src/api/middleware/auth.ts'))).toBe(false)
  })

  test('the API router imports the shared src/middleware/auth.ts', () => {
    expect(readSource('src/api/router.ts')).toContain("from '../middleware/auth'")
  })

  test('the MCP HTTP transport imports the shared src/middleware/auth.ts', () => {
    expect(readSource('src/mcp/http-transport.ts')).toContain("from '../middleware/auth'")
  })
})

describe('shared auth middleware behaviour', () => {
  const SECRET = 'shared-auth-middleware-test-secret'
  const previous: Record<string, string | undefined> = {}

  beforeAll(() => {
    for (const key of ['SYNAPTOMIND_SECRET', 'SYNAPTOMIND_SERVICE_TOKEN', 'SYNAPTOMIND_ALLOW_INSECURE']) {
      previous[key] = process.env[key]
    }
    process.env.SYNAPTOMIND_SECRET = SECRET
    delete process.env.SYNAPTOMIND_SERVICE_TOKEN
    delete process.env.SYNAPTOMIND_ALLOW_INSECURE
    resetValidTokens()
  })

  afterAll(() => {
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[key]
      else process.env[key] = value
    }
    resetValidTokens()
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
