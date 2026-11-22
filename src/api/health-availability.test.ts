import { afterEach, beforeEach, expect, test } from 'bun:test'
import { clearRegistry, getDb, register } from '../db'
import { closeDb } from '../db/init'
import { clearHealthProbeCache } from '../services/health.service'
import { configFixture, createTestDb } from '../test/helpers'
import { createApp } from './router'

// The public health view must never leak a configured identity, and a configured user whose database
// is not registered degrades it. The app takes the config it reads, so no case touches the global.
const users = [
  { id: 'private-alice', dbPath: '/private/alice.db', tokenSha256: 'a'.repeat(64) },
  { id: 'private-bob', dbPath: '/private/bob.db', tokenSha256: 'b'.repeat(64) }
]
const app = createApp(configFixture({ users }))

beforeEach(() => {
  clearRegistry()
  createTestDb()
  clearHealthProbeCache()
})
afterEach(() => {
  clearRegistry()
  clearHealthProbeCache()
  closeDb()
})

for (const available of [1, 0]) {
  test(`public health hides identities with ${available} available configured users`, async () => {
    if (available) register('private-alice', getDb())
    const res = await app.request('/health')
    const text = await res.text()
    expect(res.status).toBe(503)
    expect(JSON.parse(text).checks.database).toBe('degraded')
    expect(text).not.toContain('private')
  })
}
