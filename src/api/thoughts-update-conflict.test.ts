import { afterEach, beforeEach, expect, test } from 'bun:test'
import { closeDb } from '../db/init'
import { getThoughtByIdService } from '../services/thoughts.service'
import { createThoughtWithUrlLinksService } from '../services/url_links.service'
import { createTestDb } from '../test/helpers'
import { createApp } from './router'

// PUT /api/thoughts/:id against the v046 content-dedupe invariant (#2174 review
// finding): editing a live thought onto content another live thought in the same
// project already holds is a 409, not a raw `UNIQUE constraint failed` 500 — and
// it is refused identically on a retry, so a client cannot talk its way in.

process.env.SYNAPTOMIND_SECRET = 'test-token'
const app = createApp()

// The rate limiter is a module-level singleton keyed on the peer address, and
// every in-process `app.request` without a fake server reads as the same
// 'unknown' client — sharing that bucket with every other API suite would count
// these requests against their quota. A dedicated peer address keeps this file
// self-contained (same trick as `src/middleware/rate-limit.test.ts`).
const ENV = { server: { requestIP: () => ({ address: '10.42.0.99', family: 'IPv4', port: 1234 }) } }

async function put(id: string, body: Record<string, unknown>): Promise<Response> {
  return app.request(
    `/api/thoughts/${id}`,
    {
      method: 'PUT',
      headers: { Authorization: 'Bearer test-token', 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    },
    ENV
  )
}

beforeEach(createTestDb)
afterEach(closeDb)

test('PUT onto live content returns 409 on every attempt and writes nothing', async () => {
  const holder = createThoughtWithUrlLinksService({ content: 'content already in use' })
  const target = createThoughtWithUrlLinksService({ content: 'my own content' })

  for (let attempt = 0; attempt < 2; attempt += 1) {
    const res = await put(target.id, { content: 'content already in use' })
    expect(res.status).toBe(409)
    const body = (await res.json()) as { error: string }
    expect(body.error).toContain(holder.id)
  }

  // Both rows are exactly as they were.
  expect(getThoughtByIdService(target.id)?.content).toBe('my own content')
  expect(getThoughtByIdService(holder.id)?.content).toBe('content already in use')
})

test('PUT re-activating a thought whose content is live again returns 409', async () => {
  const archived = createThoughtWithUrlLinksService({ content: 'recycled content' })
  expect((await put(archived.id, { status: 'archived' })).status).toBe(200)
  const live = createThoughtWithUrlLinksService({ content: 'recycled content' })
  expect(live.id).not.toBe(archived.id)

  const res = await put(archived.id, { status: 'active' })
  expect(res.status).toBe(409)
  expect((await res.json()) as { error: string }).toMatchObject({ error: expect.stringContaining(live.id) })
  expect(getThoughtByIdService(archived.id)?.status).toBe('archived')
})

test('an ordinary PUT edit, activation and archive still succeed', async () => {
  const thought = createThoughtWithUrlLinksService({ content: 'ordinary content' })

  const edited = await put(thought.id, { content: 'rewritten content' })
  expect(edited.status).toBe(200)
  expect(((await edited.json()) as { content: string }).content).toBe('rewritten content')

  const activated = await put(thought.id, { status: 'active' })
  expect(activated.status).toBe(200)

  const archived = await put(thought.id, { status: 'archived' })
  expect(archived.status).toBe(200)
  expect(((await archived.json()) as { status: string }).status).toBe('archived')
})
