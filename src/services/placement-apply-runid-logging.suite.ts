/**
 * F-28 AC-F28-8 — the FOURTH record site of the run envelope: the `insertLog`
 * context (task #1050, spec
 * `2026-09-29-review-queue-adr-deviations.md` §4.5).
 *
 * `placement-apply-runid.test.ts` pins the other three sites (the proposal row
 * column, the stored `result` JSON and the returned envelope). This file pins
 * the audit line, so a committed mutation that is reachable by
 * `rollback(run_id)` is also *visible* under that id in the log.
 *
 * `insertLog` is not observable through the DB in a test: `config.logDbPath`
 * defaults to `''`, so `ensureDb()` returns null and the writer is a silent
 * no-op, and overriding the global config would leak into every suite sharing
 * this process. The writer is therefore spied with `mock.module`, and the
 * service is imported *after* the mock so it binds the spy.
 *
 * bun cannot unmock a module, so this file carries no `.test` suffix (the main
 * glob would leak the spy through `export *` re-exports — AGENTS.md §8). It is
 * run in a child process by `placement-apply-runid-logging.contract.test.ts`,
 * following `placement-rollback-logging.suite.ts`.
 */
import { afterEach, beforeEach, describe, expect, mock, test } from 'bun:test'
import type { Database } from 'bun:sqlite'
import { closeDb, getDb } from '../db'
import { createTestDb, seedEdge, seedThought } from '../test/helpers'
import { insertPendingEdge, insertPendingTriage, NOW } from './triage-apply-helpers'
// Type-only, so it is erased at compile time and cannot defeat the mock.module below.
import type { ApplyResult } from './placement-apply.types'

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

// Imported AFTER the mock: `applyProposal` / `applyBatch` must resolve
// `../logging/log` to the spy.
const { applyBatch, applyProposal } = await import('./placement-apply.service')

beforeEach(() => {
  createTestDb()
  calls.length = 0
})

afterEach(() => {
  calls.length = 0
  closeDb()
})

// ── log readers ────────────────────────────────────────────────────────────────

/** Every placement line emitted since the last `clearLogs()`, any level. */
function placementLogs(): LogCall[] {
  return calls.filter(c => c.type === 'placement')
}

/**
 * Placement lines that actually carry a run id. `persistOutcome` also logs
 * `placement` lines (stale / failed) that have no envelope, so "is a placement
 * line" and "carries a run id" are deliberately different questions.
 */
function runIdLogs(): LogCall[] {
  return placementLogs().filter(c => typeof c.metadata?.run_id === 'string' && c.metadata.run_id !== '')
}

function clearLogs(): void {
  calls.length = 0
}

// ── fixture helpers ────────────────────────────────────────────────────────────

/** An active source/target pair, unique per test. */
function activePair(_db: Database, prefix: string): { source: string; target: string } {
  return {
    source: seedThought({ id: `${prefix}-s`, content: `${prefix} source`, created_at: NOW }),
    target: seedThought({ id: `${prefix}-t`, content: `${prefix} target`, created_at: NOW }),
  }
}

/** Site 1 — the proposal row column, the rollback manifest key. */
function storedRunId(db: Database, id: string): string | null {
  const row = db.prepare('SELECT run_id FROM placement_proposals WHERE id = ?').get(id) as
    | { run_id: string | null }
    | undefined
  if (!row) throw new Error(`proposal '${id}' not found`)
  return row.run_id
}

/** The single placement line for `proposalId` (fails if it is not exactly one). */
function logFor(proposalId: string): LogCall {
  const matching = placementLogs().filter(c => c.metadata?.proposal_id === proposalId)
  expect(matching).toHaveLength(1)
  return matching[0]!
}

/**
 * Prove the spy is live in THIS test before asserting that nothing was logged.
 * A silently unmocked writer (or a real writer pointed at a no-op `logDbPath`
 * with no spy) would make every "no line" assertion pass for the wrong reason;
 * a confirming apply must file a run-id line first. The witness clears the
 * record so the caller then observes only its own scenario.
 */
function expectSpyLive(db: Database, prefix: string): void {
  const { source, target } = activePair(db, prefix)
  const row = insertPendingEdge(db, source, target, 'develops')
  const out = applyProposal(row.id, { confirm: true, now: NOW }, db)
  expect(out.status).toBe('accepted')
  expect(runIdLogs()).toHaveLength(1)
  clearLogs()
}

// ── AC-F28-8: the main accept line carries the envelope ─────────────────────────

describe('AC-F28-8: the main accept log line carries the run envelope', () => {
  test('a synthesized envelope is logged, and is the same id as the row and the result', () => {
    const db = getDb()
    const { source, target } = activePair(db, 'log1')
    const row = insertPendingEdge(db, source, target, 'develops')

    const out = applyProposal(row.id, { confirm: true, now: NOW }, db) as Extract<ApplyResult, { status: 'accepted' }>

    expect(out.status).toBe('accepted')
    expect(placementLogs()).toHaveLength(1)
    const line = logFor(row.id)
    expect(line.level).toBe('info')
    expect(line.message).toContain(`Applied placement proposal ${row.id}`)
    // The whole point of this site: the audit line is filed under the very id
    // `rollback(run_id)` needs, so a reader never has to join against the DB.
    const logged = line.metadata?.run_id
    expect(logged).toBe(out.run_id)
    expect(logged).toBe(storedRunId(db, row.id))
    // Synthesized, so marked as such; the literal UUID is owned by
    // placement-apply-runid.test.ts (AUTO_ID) and is not re-pinned here.
    expect(String(logged).startsWith('auto-')).toBe(true)
    expect(line.metadata?.item_kind).toBe('edge')
  })

  test('the idempotent accept line carries the envelope too', () => {
    const db = getDb()
    const { source, target } = activePair(db, 'log2')
    // The requested graph state already holds → the gate reports already_applied.
    seedEdge(source, target, 'develops')
    const row = insertPendingEdge(db, source, target, 'develops')

    const out = applyProposal(row.id, { confirm: true, now: NOW }, db) as Extract<ApplyResult, { status: 'accepted' }>

    expect(out.status).toBe('accepted')
    expect((out as { idempotent: boolean }).idempotent).toBe(true)
    expect(placementLogs()).toHaveLength(1)
    const line = logFor(row.id)
    // A distinct message from the committing branch: nothing was written, but
    // the row still joined the run, so the line must still name the run.
    expect(line.message).toContain('(idempotent)')
    expect(line.metadata?.run_id).toBe(out.run_id)
    expect(String(out.run_id).startsWith('auto-')).toBe(true)
  })
})

// ── AC-F28-8: a caller id is logged verbatim ───────────────────────────────────

describe('AC-F28-8: a caller-supplied run_id is logged verbatim', () => {
  test('the accept line reports the caller id, not a synthesized one', () => {
    const db = getDb()
    const { source, target } = activePair(db, 'log3')
    const row = insertPendingEdge(db, source, target, 'develops')

    applyProposal(row.id, { confirm: true, now: NOW, runId: 'run-caller-42' }, db)

    expect(placementLogs()).toHaveLength(1)
    const line = logFor(row.id)
    expect(line.metadata?.run_id).toBe('run-caller-42')
    // Equality with the row is the real assertion: the log must not re-mint.
    expect(line.metadata?.run_id).toBe(storedRunId(db, row.id))
    expect(String(line.metadata?.run_id).startsWith('auto-')).toBe(false)
  })

  test('a caller id that looks synthesized is still logged as given (prefix is advisory)', () => {
    const db = getDb()
    const { source, target } = activePair(db, 'log4')
    const row = insertPendingEdge(db, source, target, 'develops')
    const callerId = 'auto-not-really-synthesized'

    applyProposal(row.id, { confirm: true, now: NOW, runId: callerId }, db)

    // Provenance is advisory (D2): the line must not present a caller-chosen id
    // as if the service had synthesized it. Asserted as an exact match, not a
    // format, because a synthesized id would be a different string entirely.
    expect(logFor(row.id).metadata?.run_id).toBe(callerId)
  })
})

// ── AC-F28-8: a batch files every item under one shared envelope ───────────────

describe('AC-F28-8: a batch logs one shared envelope for every item', () => {
  test('both accept lines carry the batch envelope, and each names its own row', () => {
    const db = getDb()
    const first = activePair(db, 'log5-a')
    const second = activePair(db, 'log5-b')
    const rowA = insertPendingEdge(db, first.source, first.target, 'develops')
    const rowB = insertPendingEdge(db, second.source, second.target, 'develops')

    const out = applyBatch([rowA.id, rowB.id], { confirm: true, now: NOW }, db)

    // `run_id` is optional on the batch outcome; `?? null` narrows it for the
    // `toBe` overloads below while the assertion on the next line pins its type.
    const shared = out.run_id ?? null
    expect(typeof shared).toBe('string')
    // one line per committed item, no more
    expect(placementLogs()).toHaveLength(2)
    expect(runIdLogs()).toHaveLength(2)
    // The batch IS the run, so both lines must be filed under the SAME id the
    // outcome hands back — otherwise an operator greps one and loses the other.
    expect(logFor(rowA.id).metadata?.run_id).toBe(shared)
    expect(logFor(rowB.id).metadata?.run_id).toBe(shared)
    expect(storedRunId(db, rowA.id)).toBe(shared)
    expect(storedRunId(db, rowB.id)).toBe(shared)
  })
})

// ── AC-F28-8 negatives: a non-accepting outcome files no envelope ──────────────

describe('AC-F28-8: refusals and previews log no run envelope', () => {
  test('a triage confirm without a caller run_id logs nothing at all', () => {
    const db = getDb()
    // Liveness first: this test is a "nothing happened" assertion.
    expectSpyLive(db, 'log6-witness')
    const source = seedThought({ id: 'log6-src', content: 'draft src', status: 'draft', created_at: NOW })
    const row = insertPendingTriage(db, 'triage_activate', source)

    const out = applyProposal(row.id, { confirm: true, now: NOW }, db)

    expect(out.status).toBe('refused')
    expect((out as { refusal: { code: string } }).refusal.code).toBe('run_id_required')
    // Not "a line with run_id: null" — no line: nothing joined a run, so
    // announcing one would point a reader at a manifest that does not exist.
    expect(runIdLogs()).toHaveLength(0)
    expect(placementLogs()).toHaveLength(0)
    expect(calls).toHaveLength(0)
  })

  test('a dry-run logs nothing, so a preview cannot be mistaken for a commit', () => {
    const db = getDb()
    // Liveness first: this test is a "nothing happened" assertion.
    expectSpyLive(db, 'log7-witness')
    const { source, target } = activePair(db, 'log7')
    const row = insertPendingEdge(db, source, target, 'develops')

    const out = applyProposal(row.id, { confirm: false, now: NOW }, db)

    expect(out.status).toBe('dry_run')
    expect('run_id' in out).toBe(false)
    expect(runIdLogs()).toHaveLength(0)
    expect(placementLogs()).toHaveLength(0)
    expect(calls).toHaveLength(0)
  })

  test('a stale item is announced, but its warning carries no run id', () => {
    const db = getDb()
    // Liveness first: the warning count below is only meaningful if the spy
    // would otherwise have captured a run-id line.
    expectSpyLive(db, 'log8-witness')
    const { source, target } = activePair(db, 'log8')
    // Archived target → the gate reports stale, so the row never joins a run.
    db.prepare("UPDATE thoughts SET status = 'archived' WHERE id = ?").run(target)
    const row = insertPendingEdge(db, source, target, 'develops')

    const out = applyProposal(row.id, { confirm: true, now: NOW }, db)

    expect(out.status).toBe('stale')
    // The warning exists (the outcome is announced) ...
    const warnings = placementLogs().filter(c => c.level === 'warning')
    expect(warnings).toHaveLength(1)
    expect(warnings[0]!.message).toContain(row.id)
    // ... but it belongs to a row that was never enveloped.
    expect(runIdLogs()).toHaveLength(0)
    expect(storedRunId(db, row.id)).toBeNull()
  })
})
