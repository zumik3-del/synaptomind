import { Database } from 'bun:sqlite'
import { afterEach, beforeEach, describe, expect, jest, test } from 'bun:test'
import { clearRegistry, getDb, register } from '../db'
import { closeDb } from '../db/init'
import { createTestDb } from '../test/helpers'
import { MS_PER_DAY } from '../utils'
import {
  cleanupExpiredPreviewTokens,
  startPreviewTokenRetentionJob,
  stopPreviewTokenRetentionJob
} from './preview-token-retention.service'

const PREVIEW_TOKENS_DDL = `CREATE TABLE preview_tokens (
  token       TEXT PRIMARY KEY,
  kind        TEXT NOT NULL,
  target_id   TEXT NOT NULL,
  fingerprint TEXT NOT NULL,
  created_at  TEXT NOT NULL,
  expires_at  TEXT NOT NULL
)`

const scratch: Database[] = []

function scratchDb(): Database {
  const db = new Database(':memory:')
  db.run(PREVIEW_TOKENS_DDL)
  scratch.push(db)
  return db
}

function seedToken(db: Database, token: string, expiresAtMs: number): void {
  db.prepare(
    `INSERT INTO preview_tokens (token, kind, target_id, fingerprint, created_at, expires_at)
     VALUES (?, 'kind', 'target', 'fp', ?, ?)`
  ).run(token, new Date(expiresAtMs - 60_000).toISOString(), new Date(expiresAtMs).toISOString())
}

function hasToken(db: Database, token: string): boolean {
  return Boolean(db.prepare('SELECT 1 FROM preview_tokens WHERE token = ?').get(token))
}

beforeEach(createTestDb)

afterEach(async () => {
  await stopPreviewTokenRetentionJob()
  clearRegistry()
  for (const db of scratch.splice(0)) db.close()
  closeDb()
})

describe('cleanupExpiredPreviewTokens', () => {
  test('deletes expired tokens only and reports how many it removed', () => {
    const db = getDb()
    seedToken(db, 'expired', Date.now() - 1_000)
    seedToken(db, 'live', Date.now() + 60_000)

    expect(cleanupExpiredPreviewTokens(db)).toBe(1)
    expect(hasToken(db, 'expired')).toBe(false)
    expect(hasToken(db, 'live')).toBe(true)
  })
})

describe('startPreviewTokenRetentionJob sweep', () => {
  test('sweeps the default database on start and keeps its live tokens', () => {
    const db = getDb()
    seedToken(db, 'expired', Date.now() - 1_000)
    seedToken(db, 'live', Date.now() + 60_000)

    startPreviewTokenRetentionJob()

    expect(hasToken(db, 'expired')).toBe(false)
    expect(hasToken(db, 'live')).toBe(true)
  })

  test('sweeps every registered database and keeps each one would-be-expired-later token', () => {
    const first = scratchDb()
    const second = scratchDb()
    register('first', first)
    register('second', second)
    seedToken(first, 'first-expired', Date.now() - 1_000)
    seedToken(first, 'first-live', Date.now() + 60_000)
    seedToken(second, 'second-expired', Date.now() - 1_000)
    seedToken(second, 'second-live', Date.now() + 60_000)

    startPreviewTokenRetentionJob()

    expect(hasToken(first, 'first-expired')).toBe(false)
    expect(hasToken(first, 'first-live')).toBe(true)
    expect(hasToken(second, 'second-expired')).toBe(false)
    expect(hasToken(second, 'second-live')).toBe(true)
  })

  test('registered databases replace the default handle in the fan-out', () => {
    const fallback = getDb()
    seedToken(fallback, 'fallback-expired', Date.now() - 1_000)
    const user = scratchDb()
    register('user', user)
    seedToken(user, 'user-expired', Date.now() - 1_000)

    startPreviewTokenRetentionJob()

    expect(hasToken(user, 'user-expired')).toBe(false)
    expect(hasToken(fallback, 'fallback-expired')).toBe(true)
  })

  test('one throwing database does not stop the sweep of the later ones, and is logged', () => {
    const good = scratchDb()
    const bad = {
      prepare: () => {
        throw new Error('user db unavailable')
      }
    } as unknown as Database
    register('bad-user', bad)
    register('good-user', good)
    seedToken(good, 'good-expired', Date.now() - 1_000)

    const originalWrite = process.stderr.write
    let captured = ''
    process.stderr.write = ((chunk: string) => {
      captured += chunk
      return true
    }) as typeof process.stderr.write

    try {
      startPreviewTokenRetentionJob()
    } finally {
      process.stderr.write = originalWrite
    }

    expect(hasToken(good, 'good-expired')).toBe(false)
    expect(captured).toContain('Preview token retention job failed')
    expect(captured).toContain('"userId":"bad-user"')
    expect(captured).toContain('user db unavailable')
  })
})

describe('the interval job lifecycle', () => {
  test('the sweep repeats once the day interval elapses', async () => {
    jest.useFakeTimers()
    try {
      const db = getDb()
      startPreviewTokenRetentionJob()
      seedToken(db, 'next-day', Date.now() + 60_000)
      expect(hasToken(db, 'next-day')).toBe(true)

      jest.advanceTimersByTime(MS_PER_DAY)

      expect(hasToken(db, 'next-day')).toBe(false)
    } finally {
      await stopPreviewTokenRetentionJob()
      jest.useRealTimers()
    }
  })

  test('a second start does not duplicate the timer and stop clears it', async () => {
    jest.useFakeTimers()
    try {
      const db = getDb()
      startPreviewTokenRetentionJob()
      expect(jest.getTimerCount()).toBe(1)
      startPreviewTokenRetentionJob()
      expect(jest.getTimerCount()).toBe(1)

      await stopPreviewTokenRetentionJob()
      expect(jest.getTimerCount()).toBe(0)

      seedToken(db, 'after-stop', Date.now() - 1_000)
      jest.advanceTimersByTime(MS_PER_DAY)
      expect(hasToken(db, 'after-stop')).toBe(true)
    } finally {
      await stopPreviewTokenRetentionJob()
      jest.useRealTimers()
    }
  })
})
