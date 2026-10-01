/**
 * F-14 AC-7 — a confirm-time rollback-window refusal is announced exactly once
 * and the refusal path never hard-deletes a thought (task #1049).
 *
 * `insertLog` is not observable through the DB in a test: `config.logDbPath`
 * defaults to `''`, so `ensureDb()` returns null and the writer is a silent
 * no-op, and overriding the global config would leak into every suite that
 * shares this process. The writer is therefore spied with `mock.module`, and
 * the service is imported *after* the mock so it binds the spy.
 *
 * bun cannot unmock a module, so this file carries no `.test` suffix (the main
 * glob would leak the spy through `export *` re-exports — AGENTS.md §8). It is
 * run in a child process by `placement-rollback-logging.contract.test.ts`,
 * following `client.suite.ts` / `propose-degraded.suite.ts`.
 */
import { afterEach, beforeEach, describe, expect, mock, test } from 'bun:test'
import type { Database } from 'bun:sqlite'
import { config } from '../config'
import { closeDb, getDb } from '../db'
import { getThoughtRow } from '../db/thoughts'
import { createTestDb, seedThought } from '../test/helpers'
import { assertAccepted, insertPendingTriage, NOW, NOW_LATER, RUN_ID } from './triage-apply-helpers'

// The real module first, so the spy re-exports everything except the writer.
const realLog = await import('../logging/log')
type InsertLogFn = typeof realLog.insertLog
type LogLevel = Parameters<InsertLogFn>[0]
type LogMetadata = Parameters<InsertLogFn>[3]

type LogCall = { level: LogLevel; type: string; message: string; metadata: LogMetadata }

const calls: LogCall[] = []

mock.module('../logging/log', () => ({
  ...realLog,
  insertLog: (
    level: LogLevel,
    type: string,
    message: string,
    metadata?: Record<string, unknown>
  ): void => {
    calls.push({ level, type, message, metadata })
  }
}))

// Imported AFTER the mock: `rollback` must resolve `../logging/log` to the spy.
// `placement-apply.service` comes along so the fixtures are produced by the real
// writer path, not by hand-built rows.
const { applyProposal } = await import('./placement-apply.service')
const { rollback } = await import('./placement-rollback.service')

beforeEach(() => {
  createTestDb()
  calls.length = 0
})

afterEach(() => {
  calls.length = 0
  closeDb()
})

const DAY_MS = 86_400_000
/** Documented default (`src/config.ts:99`); the message names the width. */
const DEFAULT_TTL_DAYS = 30
/** Old enough to sit outside any window these tests open. */
const ANCIENT = '2000-01-01T00:00:00.000Z'

// ── helpers ──────────────────────────────────────────────────────────────────

/** The inclusive cutoff of the rollback window opened at `now`. */
function cutoffFor(now: string, ttlDays = config.placement.proposalTtlDays): string {
  return new Date(Date.parse(now) - ttlDays * DAY_MS).toISOString()
}

/** Apply a triage row at `NOW` under `RUN_ID`, then return its accepted row id. */
function acceptedRow(
  db: Database,
  itemKind: 'triage_activate' | 'triage_archive',
  sourceId: string,
  targetId: string | null = null
): string {
  const row = insertPendingTriage(db, itemKind, sourceId, targetId)
  const out = applyProposal(row.id, { confirm: true, now: NOW, runId: RUN_ID }, db)
  expect(out.status).toBe('accepted')
  assertAccepted(db, row.id)
  return row.id
}

/** Age an accepted row in place (see placement-rollback.service.test.ts:74). */
function setDecidedAt(db: Database, id: string, decidedAt: string | null): void {
  const { changes } = db.prepare('UPDATE placement_proposals SET decided_at = ? WHERE id = ?').run(decidedAt, id)
  if (changes === 0) throw new Error(`proposal '${id}' not found`)
}

/** Every placement log line emitted since the last `clearLogs()`. */
function placementLogs(level: LogLevel): LogCall[] {
  return calls.filter(c => c.level === level && c.type === 'placement')
}

function clearLogs(): void {
  calls.length = 0
}

/** Ids of every thought row — the hard-delete witness (AC-F14-7). */
function thoughtIds(db: Database): string[] {
  return (db.prepare('SELECT id FROM thoughts ORDER BY id').all() as { id: string }[]).map(r => r.id)
}

// ── AC-F14-7: one warning per confirm-time window refusal ─────────────────────

describe('F-14 AC-7: the window refusal is announced exactly once', () => {
  test('a confirm-time refusal emits exactly one placement warning naming the cutoff', () => {
    const db = getDb()
    const source = seedThought({ id: 'f14-7-w-s', content: 'warned refusal src', status: 'draft', created_at: NOW })
    const rowId = acceptedRow(db, 'triage_activate', source)
    setDecidedAt(db, rowId, ANCIENT)
    clearLogs()

    const report = rollback(RUN_ID, { confirm: true, now: NOW_LATER }, db)

    expect(report.summary).toEqual({ reverted: 0, skipped: 0, refused: 1 })

    const warnings = placementLogs('warning')
    // exactly one — not zero (an unannounced refusal) and not two (a
    // double-logged or per-item duplicate emission)
    expect(warnings).toHaveLength(1)
    expect(calls).toHaveLength(1)

    const [warning] = warnings
    expect(warning!.type).toBe('placement')
    expect(warning!.level).toBe('warning')
    // names the window and the concrete cutoff a reader can act on
    expect(warning!.message).toContain('Rollback refused')
    expect(warning!.message).toContain('rollback window')
    expect(warning!.message).toContain(`${DEFAULT_TTL_DAYS}d`)
    expect(warning!.message).toContain(`cutoff ${cutoffFor(NOW_LATER)}`)
    // and identifies the row it is about
    expect(warning!.message).toContain(rowId)
    expect(warning!.metadata).toEqual({
      proposal_id: rowId,
      run_id: RUN_ID,
      item_kind: 'triage_activate'
    })
  })

  test('the count tracks refusals: one warning per refused row, none for a revert', () => {
    const db = getDb()
    const fresh = seedThought({ id: 'f14-7-mix-fresh', content: 'mixed in window src', status: 'draft', created_at: NOW })
    const first = seedThought({ id: 'f14-7-mix-a', content: 'mixed old one', status: 'draft', created_at: NOW })
    const second = seedThought({ id: 'f14-7-mix-b', content: 'mixed old two', status: 'draft', created_at: NOW })
    const freshRow = acceptedRow(db, 'triage_activate', fresh)
    const firstRow = acceptedRow(db, 'triage_activate', first)
    const secondRow = acceptedRow(db, 'triage_activate', second)
    setDecidedAt(db, firstRow, ANCIENT)
    setDecidedAt(db, secondRow, ANCIENT)
    clearLogs()

    const report = rollback(RUN_ID, { confirm: true, now: NOW_LATER }, db)

    expect(report.summary).toEqual({ reverted: 1, skipped: 0, refused: 2 })
    const warnings = placementLogs('warning')
    expect(warnings).toHaveLength(2)
    // one warning per refused row, and each names its own row
    const named = new Set(warnings.map(w => w.metadata?.proposal_id))
    expect(named).toEqual(new Set([firstRow, secondRow]))
    // the reverted row is announced as info, never as a warning
    expect(warnings.some(w => w.message.includes(freshRow))).toBe(false)
    const infos = placementLogs('info')
    expect(infos).toHaveLength(1)
    expect(infos[0]!.metadata?.proposal_id).toBe(freshRow)
    // three rows, three lines: nothing extra is emitted
    expect(calls).toHaveLength(3)
  })

  test('a dry-run refusal is not announced — the warning is confirm-gated', () => {
    const db = getDb()
    const source = seedThought({ id: 'f14-7-dry-s', content: 'dry run refusal src', status: 'draft', created_at: NOW })
    const rowId = acceptedRow(db, 'triage_activate', source)
    setDecidedAt(db, rowId, ANCIENT)
    clearLogs()

    const report = rollback(RUN_ID, { confirm: false, now: NOW_LATER }, db)

    expect(report.summary).toEqual({ reverted: 0, skipped: 0, refused: 1 })
    // the refusal is reported, not announced: a preview logs nothing
    expect(calls).toHaveLength(0)
    expect(placementLogs('warning')).toHaveLength(0)
    expect(placementLogs('info')).toHaveLength(0)
  })
})

// ── AC-F14-7: a refusal never hard-deletes a thought ─────────────────────────

describe('F-14 AC-7: the refusal path never hard-deletes a thought', () => {
  test('the source thought of a refused row survives, still activated', () => {
    const db = getDb()
    const source = seedThought({ id: 'f14-7-del-s', content: 'refused source src', status: 'draft', created_at: NOW })
    const rowId = acceptedRow(db, 'triage_activate', source)
    setDecidedAt(db, rowId, ANCIENT)
    const idsBefore = thoughtIds(db)
    clearLogs()

    rollback(RUN_ID, { confirm: true, now: NOW_LATER }, db)

    // the row is still readable by id, not a tombstone
    const row = getThoughtRow(db, source)
    expect(row).not.toBeNull()
    expect(row!.status).toBe('active')
    // and nothing was dropped from the table
    expect(thoughtIds(db)).toEqual(idsBefore)
    assertAccepted(db, rowId)
  })

  test('a mixed run reverts and refuses without losing any thought row', () => {
    const db = getDb()
    const fresh = seedThought({ id: 'f14-7-mix2-fresh', content: 'mixed2 in window src', status: 'draft', created_at: NOW })
    const old = seedThought({ id: 'f14-7-mix2-old', content: 'mixed2 out of window src', status: 'draft', created_at: NOW })
    const freshRow = acceptedRow(db, 'triage_activate', fresh)
    const oldRow = acceptedRow(db, 'triage_activate', old)
    setDecidedAt(db, oldRow, ANCIENT)
    const idsBefore = thoughtIds(db)
    clearLogs()

    const report = rollback(RUN_ID, { confirm: true, now: NOW_LATER }, db)

    expect(report.summary).toEqual({ reverted: 1, skipped: 0, refused: 1 })
    // the inverse writer only ever moves `status` back — the id set is stable
    expect(thoughtIds(db)).toEqual(idsBefore)
    expect(getThoughtRow(db, fresh)!.status).toBe('draft')
    expect(getThoughtRow(db, old)!.status).toBe('active')
    expect(placementLogs('warning')).toHaveLength(1)
    expect(freshRow).not.toBe(oldRow)
  })
})
