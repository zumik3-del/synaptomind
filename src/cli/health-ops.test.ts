import { afterEach, expect, test } from 'bun:test'
import { Database } from 'bun:sqlite'
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { config } from '../config'
import { openDatabase } from '../db/init'
import { runOpsHealthCheck } from './index'

const users = config.users
const path = config.db.path
const dir = mkdtempSync(join(tmpdir(), 'ops-health-'))
afterEach(() => {
  config.users = users
  config.db.path = path
})

test('all configured missing users fail without creating databases', async () => {
  const missing = join(dir, 'missing.db')
  config.users = [{ id: 'alice', dbPath: missing, tokenSha256: 'a' }]
  const result = await runOpsHealthCheck()
  expect(result.aggregate).toBe('degraded')
  expect(result.users.map(u => [u.userId, u.status])).toEqual([['alice', 'degraded']])
  expect(existsSync(missing)).toBe(false)
})

test('unknown user fails instead of producing an empty success', async () => {
  config.users = [{ id: 'alice', dbPath: join(dir, 'missing.db'), tokenSha256: 'a' }]
  const result = await runOpsHealthCheck({ user: 'unknown' })
  expect(result.aggregate).toBe('degraded')
  expect(result.users).toEqual([{ userId: 'unknown', status: 'degraded', error: 'not configured' }])
})

test('legacy mode selects default database and does not create it', async () => {
  config.users = []
  config.db.path = join(dir, 'legacy.db')
  const result = await runOpsHealthCheck()
  expect(result.users[0].userId).toBe('default')
  expect(result.aggregate).toBe('degraded')
  expect(existsSync(config.db.path)).toBe(false)
})

test('healthy legacy database is checked read-only and its handle is closed', async () => {
  const legacy = join(dir, 'healthy-legacy.db')
  const seed = openDatabase({ dbPath: legacy, runMigrations: true })
  seed.close()
  const before = readFileSync(legacy)
  config.users = []
  config.db.path = legacy
  const close = Database.prototype.close
  const closed: Database[] = []
  Database.prototype.close = function (...args) {
    closed.push(this)
    return close.apply(this, args)
  }
  try {
    const result = await runOpsHealthCheck()
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
  config.users = []
  config.db.path = broken
  const close = Database.prototype.close
  const closed: Database[] = []
  Database.prototype.close = function (...args) {
    closed.push(this)
    return close.apply(this, args)
  }
  try {
    const result = await runOpsHealthCheck()
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
  config.users = [
    { id: 'alice', dbPath: existing, tokenSha256: 'a' },
    { id: 'bob', dbPath: join(dir, 'absent.db'), tokenSha256: 'b' }
  ]
  const result = await runOpsHealthCheck()
  expect(result.aggregate).toBe('degraded')
  expect(result.users[0].report?.summary).toBeDefined()
  expect(result.users[1].status).toBe('degraded')
  expect(readFileSync(existing)).toEqual(before)
})

process.on('exit', () => rmSync(dir, { recursive: true, force: true }))
