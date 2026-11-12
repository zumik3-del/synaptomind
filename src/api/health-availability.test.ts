import { afterEach, beforeEach, expect, test } from 'bun:test'
import { config } from '../config'
import { clearRegistry, getDb, register } from '../context/container'
import { closeDb } from '../db/init'
import { clearHealthProbeCache } from '../services/health.service'
import { createTestDb } from '../test/helpers'
import { createApp } from './router'

const users = config.users
const app = createApp()

beforeEach(() => {
  clearRegistry()
  config.users = []
  createTestDb()
  clearHealthProbeCache()
  config.users = [
    { id: 'private-alice', dbPath: '/private/alice.db', tokenSha256: 'a' },
    { id: 'private-bob', dbPath: '/private/bob.db', tokenSha256: 'b' }
  ]
})
afterEach(() => {
  config.users = users
  clearRegistry()
  clearHealthProbeCache()
  closeDb()
})

for (const available of [1, 0]) {
  test(`public health hides identities with ${available} available configured users`, async () => {
    if (available) {
      config.users = []
      const db = getDb()
      config.users = [
        { id: 'private-alice', dbPath: '/private/alice.db', tokenSha256: 'a' },
        { id: 'private-bob', dbPath: '/private/bob.db', tokenSha256: 'b' }
      ]
      register('private-alice', db)
    }
    const res = await app.request('/health')
    const text = await res.text()
    expect(res.status).toBe(503)
    expect(JSON.parse(text).checks.database).toBe('degraded')
    expect(text).not.toContain('private')
  })
}
