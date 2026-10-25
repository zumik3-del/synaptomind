import { Database } from 'bun:sqlite'
import { afterEach, beforeEach, expect, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { vec0Path } from '../runtime-mode'
import { createTestDb } from '../test/helpers'
import { getDb } from './container'
import { closeDb, initDb } from './init'
import {
  createPreviewToken,
  getPreviewToken,
  consumePreviewToken,
  deleteExpiredPreviewTokens,
  isPreviewTokenExpired,
} from './preview-tokens'
import {
  createPreviewTokenService,
  consumePreviewTokenService,
  type VerifyPreviewTokenResult,
} from '../services/preview-tokens.service'

beforeEach(createTestDb)
afterEach(closeDb)

test('consumePreviewToken returns row once then undefined', () => {
  const db = getDb()
  const token = createPreviewToken(db, 'kind', 'target', 'fp')
  const row = consumePreviewToken(db, token)
  expect(row?.token).toBe(token)
  expect(consumePreviewToken(db, token)).toBeUndefined()
  expect(getPreviewToken(db, token)).toBeUndefined()
})

test('expired tokens are swept', () => {
  const db = getDb()
  const token = createPreviewToken(db, 'kind', 'target', 'fp', 0)
  const future = new Date(Date.now() + 1000).toISOString()
  const swept = deleteExpiredPreviewTokens(db, future)
  expect(swept).toBeGreaterThanOrEqual(1)
  expect(getPreviewToken(db, token)).toBeUndefined()
})

test('isPreviewTokenExpired reflects expires_at', () => {
  const past = new Date(Date.now() - 1000).toISOString()
  expect(isPreviewTokenExpired(past)).toBeTrue()
})

// ── claim-and-validate is one step (#2174 review finding) ────────────────────
//
// The confirm path used to verify a token (read) and consume it (delete) in two
// statements, so two confirms could both pass verification and both apply their
// mutation. `consumePreviewTokenService` now claims first — a single
// `DELETE ... RETURNING` — and validates the row it received.

test('two confirms of one token: exactly one is valid, the other reads not_found', () => {
  const db = getDb()
  const token = createPreviewTokenService('kind', 'target', 'fp', db)

  const results = [
    consumePreviewTokenService(token, 'kind', 'target', 'fp', db),
    consumePreviewTokenService(token, 'kind', 'target', 'fp', db),
  ]

  expect(results.filter(r => r.valid)).toHaveLength(1)
  expect(results[0].valid).toBeTrue()
  expect(results[1]).toEqual({ valid: false, reason: 'not_found' })
  expect(getPreviewToken(db, token)).toBeUndefined()
})

test('a rejected claim still burns the token: a stale or misdirected confirm cannot be replayed', () => {
  const db = getDb()
  type RejectionReason = NonNullable<VerifyPreviewTokenResult['reason']>
  const cases: Array<{ label: string; token: string; args: [string, string, string]; reason: RejectionReason }> = [
    {
      label: 'fingerprint drifted since the preview',
      token: createPreviewTokenService('kind', 'target', 'fp', db),
      args: ['kind', 'target', 'fp-changed'],
      reason: 'stale',
    },
    {
      label: 'token issued for another action',
      token: createPreviewTokenService('kind', 'target', 'fp', db),
      args: ['other-kind', 'target', 'fp'],
      reason: 'kind_mismatch',
    },
    {
      label: 'token issued for another target',
      token: createPreviewTokenService('kind', 'target', 'fp', db),
      args: ['kind', 'other-target', 'fp'],
      reason: 'target_mismatch',
    },
    {
      label: 'token already expired',
      // db-layer helper: the service pins its own TTL, this one takes the expiry.
      token: createPreviewToken(db, 'kind', 'target', 'fp', -1),
      args: ['kind', 'target', 'fp'],
      reason: 'expired',
    },
  ]

  for (const item of cases) {
    expect({ label: item.label, result: consumePreviewTokenService(item.token, item.args[0], item.args[1], item.args[2], db) }).toEqual({
      label: item.label,
      result: { valid: false, reason: item.reason },
    })
    // Fail closed: the refused confirm consumed the row, so the same token
    // cannot be replayed even with the correct arguments.
    expect(consumePreviewTokenService(item.token, 'kind', 'target', 'fp', db)).toEqual({ valid: false, reason: 'not_found' })
    expect(getPreviewToken(db, item.token)).toBeUndefined()
  }
})

test('a claim in flight cannot be granted twice across connections', () => {
  // Two connections against one file is the only way to observe the race: a
  // single `bun:sqlite` handle is synchronous, so two calls on it are strictly
  // ordered. Booting a real file-backed DB also covers the WAL write path.
  const dir = mkdtempSync(join(tmpdir(), 'synaptomind-token-race-'))
  const dbPath = join(dir, 'test.db')
  try {
    initDb({ dbPath, runMigrations: true })
    const owner = getDb()
    const token = createPreviewToken(owner, 'kind', 'target', 'fp')

    const racer = new Database(dbPath)
    racer.loadExtension(vec0Path())
    racer.run('PRAGMA busy_timeout = 0')
    try {
      // First confirm claims the row and holds the write lock — the window a
      // second confirm arrives in.
      owner.run('BEGIN IMMEDIATE')
      expect(consumePreviewToken(owner, token)?.token).toBe(token)

      // The second confirm cannot read the claimed row: SQLite refuses the
      // write (busy) rather than handing the row out again. Either way, it
      // never becomes a second valid claim.
      expect(() => consumePreviewToken(racer, token)).toThrow(/SQLITE_BUSY|database is locked/)

      owner.run('COMMIT')
      expect(consumePreviewToken(racer, token)).toBeUndefined()
    } finally {
      racer.close(true)
    }
  } finally {
    closeDb()
    rmSync(dir, { recursive: true, force: true })
  }
})
