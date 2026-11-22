import { expect, test } from 'bun:test'
import { Database } from 'bun:sqlite'
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { config } from '../config'
import { openDatabase } from '../db/init'
import { configFixture } from '../test/helpers'
import { runOpsHealthCheck } from './index'

const dir = mkdtempSync(join(tmpdir(), 'ops-health-'))

function configured(users: Array<{ id: string; dbPath: string }>, dbPath = config.db.path) {
  return configFixture({
    users: users.map(user => ({ ...user, tokenSha256: 'a'.repeat(64) })),
    db: { ...config.db, path: dbPath }
  })
}

test('all configured missing users fail without creating databases', async () => {
  const missing = join(dir, 'missing.db')
  const result = await runOpsHealthCheck({}, configured([{ id: 'alice', dbPath: missing }]))
  expect(result.aggregate).toBe('degraded')
  expect(result.users.map(u => [u.userId, u.status])).toEqual([['alice', 'degraded']])
  expect(existsSync(missing)).toBe(false)
})

test('unknown user fails instead of producing an empty success', async () => {
  const cfg = configured([{ id: 'alice', dbPath: join(dir, 'missing.db') }])
  const result = await runOpsHealthCheck({ user: 'unknown' }, cfg)
  expect(result.aggregate).toBe('degraded')
  expect(result.users).toEqual([{ userId: 'unknown', status: 'degraded', error: 'not configured' }])
})

test('legacy mode selects default database and does not create it', async () => {
  const legacy = join(dir, 'legacy.db')
  const result = await runOpsHealthCheck({}, configured([], legacy))
  expect(result.users[0].userId).toBe('default')
  expect(result.aggregate).toBe('degraded')
  expect(existsSync(legacy)).toBe(false)
})

test('healthy legacy database is checked read-only and its handle is closed', async () => {
  const legacy = join(dir, 'healthy-legacy.db')
  const seed = openDatabase({ dbPath: legacy, runMigrations: true })
  seed.close()
  const before = readFileSync(legacy)
  const close = Database.prototype.close
  const closed: Database[] = []
  Database.prototype.close = function (...args) {
    closed.push(this)
    return close.apply(this, args)
  }
  try {
    const result = await runOpsHealthCheck({}, configured([], legacy))
    expect(result.aggregate).toBe('ok')
    expect(result.users[0].userId).toBe('default')
    expect(result.users[0].report?.summary.critical).toBe(0)
    expect(closed).toHaveLength(1)
    expect(() => closed[0].query('SELECT 1').get()).toThrow()
    expect(readFileSync(legacy)).toEqual(before)
  } finally {
    Database.prototype.close = close
  }
})

test('diagnostic errors also close the opened database', async () => {
  const broken = join(dir, 'unmigrated.db')
  const seed = new Database(broken, { create: true })
  seed.run('CREATE TABLE unrelated (id INTEGER)')
  seed.close()
  const close = Database.prototype.close
  const closed: Database[] = []
  Database.prototype.close = function (...args) {
    closed.push(this)
    return close.apply(this, args)
  }
  try {
    const result = await runOpsHealthCheck({}, configured([], broken))
    expect(result.aggregate).toBe('degraded')
    expect(result.users[0].error).toBeDefined()
    expect(closed).toHaveLength(1)
    expect(() => closed[0].query('SELECT 1').get()).toThrow()
  } finally {
    Database.prototype.close = close
  }
})

test('partial availability runs substantive diagnostics without altering the existing database', async () => {
  const existing = join(dir, 'existing.db')
  const db = openDatabase({ dbPath: existing, runMigrations: true })
  db.close()
  const before = readFileSync(existing)
  const cfg = configured([
    { id: 'alice', dbPath: existing },
    { id: 'bob', dbPath: join(dir, 'absent.db') }
  ])
  const result = await runOpsHealthCheck({}, cfg)
  expect(result.aggregate).toBe('degraded')
  expect(result.users[0].report?.summary).toBeDefined()
  expect(result.users[1].status).toBe('degraded')
  expect(readFileSync(existing)).toEqual(before)
})

process.on('exit', () => rmSync(dir, { recursive: true, force: true }))
