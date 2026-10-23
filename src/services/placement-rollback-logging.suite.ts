/**
 * F-14 AC-7 — a confirm-time rollback-window refusal is announced exactly once
 * and the refusal path never hard-deletes a thought (task #1049).
 *
 * `insertLog` now routes to stdout/stderr sinks; spying it keeps the suite
 * deterministic and silent. Overriding the global config would leak into every
 * suite that shares this process. The writer is therefore spied with
 * `mock.module`, and
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
import { getEdgePairBetween } from '../db/edges'
import { getThoughtRow } from '../db/thoughts'
import { createTestDb, seedThought } from '../test/helpers'
import { assertAccepted, insertPendingEdge, NOW, NOW_LATER, PAST, RUN_ID } from '../test/proposal-apply-helpers'

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
const { applyProposalService } = await import('./placement-apply.service')
const { rollbackService } = await import('./placement-rollback.service')

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

interface AcceptedEdge {
  rowId: string
  source: string
  target: string
}

/** Accept one `edge` row between a fresh active pair at `NOW`; returns its id and ends. */
function acceptedRow(db: Database, id: string): AcceptedEdge {
  const source = seedThought({ id: `${id}-s`, content: `${id} source content`, status: 'active', created_at: NOW })
  const target = seedThought({ id: `${id}-t`, content: `${id} target content`, status: 'active', created_at: PAST })
  const row = insertPendingEdge(db, source, target, 'related')
  const out = applyProposalService(row.id, { confirm: true, now: NOW, runId: RUN_ID }, db)
  expect(out.status).toBe('accepted')
  assertAccepted(db, row.id)
  return { rowId: row.id, source, target }
}

/** Does the accepted edge still exist in the graph? */
function edgeHeld(db: Database, pair: AcceptedEdge): boolean {
  return getEdgePairBetween(db, pair.source, pair.target) !== null
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
    const pair = acceptedRow(db, 'f14-7-w')
    setDecidedAt(db, pair.rowId, ANCIENT)
    clearLogs()

    const report = rollbackService(RUN_ID, { confirm: true, now: NOW_LATER }, db)

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
    expect(warning!.message).toContain(pair.rowId)
    expect(warning!.metadata).toEqual({
      proposal_id: pair.rowId,
      run_id: RUN_ID,
      item_kind: 'edge'
    })
  })

  test('the count tracks refusals: one warning per refused row, none for a revert', () => {
    const db = getDb()
    const fresh = acceptedRow(db, 'f14-7-mix-fresh')
    const first = acceptedRow(db, 'f14-7-mix-a')
    const second = acceptedRow(db, 'f14-7-mix-b')
    setDecidedAt(db, first.rowId, ANCIENT)
    setDecidedAt(db, second.rowId, ANCIENT)
    clearLogs()

    const report = rollbackService(RUN_ID, { confirm: true, now: NOW_LATER }, db)

    expect(report.summary).toEqual({ reverted: 1, skipped: 0, refused: 2 })
    const warnings = placementLogs('warning')
    expect(warnings).toHaveLength(2)
    // one warning per refused row, and each names its own row
    const named = new Set(warnings.map(w => w.metadata?.proposal_id))
    expect(named).toEqual(new Set([first.rowId, second.rowId]))
    // the reverted row is announced as info, never as a warning
    expect(warnings.some(w => w.message.includes(fresh.rowId))).toBe(false)
    const infos = placementLogs('info')
    expect(infos).toHaveLength(1)
    expect(infos[0]!.metadata?.proposal_id).toBe(fresh.rowId)
    // three rows, three lines: nothing extra is emitted
    expect(calls).toHaveLength(3)
  })

  test('a dry-run refusal is not announced — the warning is confirm-gated', () => {
    const db = getDb()
    const pair = acceptedRow(db, 'f14-7-dry')
    setDecidedAt(db, pair.rowId, ANCIENT)
    clearLogs()

    const report = rollbackService(RUN_ID, { confirm: false, now: NOW_LATER }, db)

    expect(report.summary).toEqual({ reverted: 0, skipped: 0, refused: 1 })
    // the refusal is reported, not announced: a preview logs nothing
    expect(calls).toHaveLength(0)
    expect(placementLogs('warning')).toHaveLength(0)
    expect(placementLogs('info')).toHaveLength(0)
  })
})

// ── AC-F14-7: a refusal never hard-deletes a thought ─────────────────────────

describe('F-14 AC-7: the refusal path never hard-deletes a thought', () => {
  test('the source thought of a refused row survives, still active', () => {
    const db = getDb()
    const pair = acceptedRow(db, 'f14-7-del')
    setDecidedAt(db, pair.rowId, ANCIENT)
    const idsBefore = thoughtIds(db)
    clearLogs()

    rollbackService(RUN_ID, { confirm: true, now: NOW_LATER }, db)

    // the row is still readable by id, not a tombstone
    const row = getThoughtRow(db, pair.source)
    expect(row).not.toBeNull()
    expect(row!.status).toBe('active')
    // and nothing was dropped from the table
    expect(thoughtIds(db)).toEqual(idsBefore)
    assertAccepted(db, pair.rowId)
    expect(edgeHeld(db, pair)).toBe(true)
  })

  test('a mixed run reverts and refuses without losing any thought row', () => {
    const db = getDb()
    const fresh = acceptedRow(db, 'f14-7-mix2-fresh')
    const old = acceptedRow(db, 'f14-7-mix2-old')
    setDecidedAt(db, old.rowId, ANCIENT)
    const idsBefore = thoughtIds(db)
    clearLogs()

    const report = rollbackService(RUN_ID, { confirm: true, now: NOW_LATER }, db)

    expect(report.summary).toEqual({ reverted: 1, skipped: 0, refused: 1 })
    // the inverse writer only ever deletes the edge it created — the id set is stable
    expect(thoughtIds(db)).toEqual(idsBefore)
    expect(edgeHeld(db, fresh)).toBe(false)
    expect(edgeHeld(db, old)).toBe(true)
    expect(placementLogs('warning')).toHaveLength(1)
    expect(fresh.rowId).not.toBe(old.rowId)
  })
})
