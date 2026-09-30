/**
 * F-28 run-envelope synthesis on `apply` / `apply_batch` (task #1050, spec
 * `2026-09-29-review-queue-adr-deviations.md` §4.5).
 *
 * Before F-28 a confirming `edge` / `placement` / `lifecycle` apply that the
 * caller left un-enveloped committed a graph mutation with `row.run_id = NULL`,
 * so no `rollback(run_id)` could ever reach it. The service now synthesizes one
 * `auto-` envelope per accepted row (single) or per batch, and the accepted row
 * is the rollback manifest.
 *
 * This suite pins the three DB/envelope record sites: the proposal row, the
 * stored `result` JSON and the returned envelope. The fourth site — the
 * `insertLog` context — needs a `mock.module` spy and therefore lives in
 * `placement-apply-runid-logging.suite.ts`.
 *
 * Clocks: every rollback round-trip pins `now` INSIDE the F-14 window
 * (`placement.proposalTtlDays`, default 30 d). `NOW` → `NOW_LATER` is 19 days,
 * so `windowRefusal` returns `null` and the row reaches the revert/skip
 * branches; an out-of-window clock reports `refused` and would look like a
 * synthesis failure when it is not (`triage-apply-helpers.ts:11-19`).
 */
import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import type { Database } from 'bun:sqlite'
import { closeDb, getDb } from '../db'
import { createTestDb, seedEdge, seedThought } from '../test/helpers'
import { applyBatch, applyProposal } from './placement-apply.service'
import type { AcceptedApplyResult, ApplyBatchOutcome, ApplyResult } from './placement-apply.types'
import { rollback } from './placement-rollback.service'
import {
  assertAccepted,
  assertRolledBack,
  assertStillPending,
  insertPendingEdge,
  insertPendingTriage,
  NOW,
  NOW_LATER,
} from './triage-apply-helpers'

beforeEach(createTestDb)
afterEach(closeDb)

/** D2: synthesized ids are `auto-` + a UUIDv7. The prefix is advisory only. */
const AUTO_ID = /^auto-[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/

// ── record-site readers ────────────────────────────────────────────────────────

interface StoredProposal {
  state: string
  run_id: string | null
  result: string | null
  decided_at: string | null
  applied_at: string | null
}

function stored(db: Database, id: string): StoredProposal {
  const row = db.prepare('SELECT state, run_id, result, decided_at, applied_at FROM placement_proposals WHERE id = ?').get(id) as
    | StoredProposal
    | undefined
  if (!row) throw new Error(`proposal '${id}' not found`)
  return row
}

/** `result.run_id` — the audit echo (D6); the column stays the rollback key. */
function resultRunId(db: Database, id: string): unknown {
  const raw = stored(db, id).result
  if (raw === null) throw new Error(`proposal '${id}' has no stored result`)
  return (JSON.parse(raw) as Record<string, unknown>).run_id
}

function storedResult(db: Database, id: string): Record<string, unknown> {
  const raw = stored(db, id).result
  if (raw === null) throw new Error(`proposal '${id}' has no stored result`)
  return JSON.parse(raw) as Record<string, unknown>
}

/**
 * Assert an id is a synthesized envelope: non-null and `auto-` prefixed. The
 * literal value is never asserted — only its shape and its equality across the
 * record sites, so a UUIDv7 refactor cannot break this suite.
 */
function expectSynthesizedRunId(value: string | null | undefined): string {
  expect(typeof value).toBe('string')
  expect(value).not.toBeNull()
  expect(value!.startsWith('auto-')).toBe(true)
  return value as string
}

/** Apply and return the accepted envelope, asserting it really was accepted. */
function applyAccepted(id: string, db: Database, runId?: string): AcceptedApplyResult {
  const out = applyProposal(id, { confirm: true, now: NOW, ...(runId === undefined ? {} : { runId }) }, db)
  expect(out.status).toBe('accepted')
  return out as AcceptedApplyResult
}

/** An active source/target pair, unique per test. */
function activePair(_db: Database, prefix: string): { source: string; target: string } {
  return {
    source: seedThought({ id: `${prefix}-s`, content: `${prefix} source`, created_at: NOW }),
    target: seedThought({ id: `${prefix}-t`, content: `${prefix} target`, created_at: NOW }),
  }
}

function edgeBetween(db: Database, source: string, target: string, type: string): boolean {
  return db.prepare('SELECT id FROM edges WHERE source_id = ? AND target_id = ? AND type = ?').get(source, target, type) !== null
}

// ── AC-F28-1: a single un-enveloped apply synthesizes one envelope ──────────────

describe('AC-F28-1: single non-triage apply without a caller run_id', () => {
  test('row, stored result and returned envelope all carry the same synthesized id', () => {
    const db = getDb()
    const { source, target } = activePair(db, 'ac1')
    const row = insertPendingEdge(db, source, target, 'develops')

    const out = applyAccepted(row.id, db)

    const id = expectSynthesizedRunId(out.run_id)
    // site 1: the proposal row — the rollback manifest key
    expect(stored(db, row.id).run_id).toBe(id)
    // site 2: the stored result JSON (audit echo, D6)
    expect(resultRunId(db, row.id)).toBe(id)
    // site 3: the returned envelope, so the caller needs no second query
    expect(out.result).not.toBeNull()
    expect((JSON.parse(out.result!) as Record<string, unknown>).run_id).toBe(id)
    // the row really was accepted and really did write the graph
    assertAccepted(db, row.id)
    expect(edgeBetween(db, source, target, 'develops')).toBe(true)
  })

  test('the synthesized id is an auto- prefixed UUIDv7 (D2 format)', () => {
    const db = getDb()
    const { source, target } = activePair(db, 'ac1-fmt')
    const row = insertPendingEdge(db, source, target, 'develops')

    const out = applyAccepted(row.id, db)

    // One dedicated test owns the literal FORMAT so a deliberate format change
    // fails here and not in every cross-site equality assertion above.
    expect(out.run_id).toMatch(AUTO_ID)
  })

  test('two un-enveloped applies synthesize two distinct envelopes', () => {
    const db = getDb()
    const first = activePair(db, 'ac1-a')
    const second = activePair(db, 'ac1-b')
    const rowA = insertPendingEdge(db, first.source, first.target, 'develops')
    const rowB = insertPendingEdge(db, second.source, second.target, 'develops')

    const a = expectSynthesizedRunId(applyAccepted(rowA.id, db).run_id)
    const b = expectSynthesizedRunId(applyAccepted(rowB.id, db).run_id)

    // A shared id would merge two independent applies into one manifest.
    expect(a).not.toBe(b)
  })

  test('re-applying the accepted row echoes the same envelope instead of minting a new one', () => {
    const db = getDb()
    const { source, target } = activePair(db, 'ac1-again')
    const row = insertPendingEdge(db, source, target, 'develops')
    const first = expectSynthesizedRunId(applyAccepted(row.id, db).run_id)

    const again = applyProposal(row.id, { confirm: true, now: NOW_LATER }, db) as AcceptedApplyResult

    expect(again.status).toBe('accepted')
    expect(again.idempotent).toBe(true)
    expect(again.run_id).toBe(first)
    expect(stored(db, row.id).run_id).toBe(first)
  })
})

// ── AC-F28-2: the synthesized envelope is rollback-addressable ──────────────────

describe('AC-F28-2: rollback of the synthesized envelope reverts the row', () => {
  test('apply un-enveloped, then rollback that id, actually reverts the graph', () => {
    const db = getDb()
    const { source, target } = activePair(db, 'ac2')
    const row = insertPendingEdge(db, source, target, 'develops')

    const runId = expectSynthesizedRunId(applyAccepted(row.id, db).run_id)
    expect(edgeBetween(db, source, target, 'develops')).toBe(true)

    // In-window clock: NOW → NOW_LATER is 19 d < proposalTtlDays 30, so the
    // F-14 window check passes and the revert branch is reached.
    const report = rollback(runId, { confirm: true, now: NOW_LATER }, db)

    expect(report.summary).toEqual({ reverted: 1, skipped: 0, refused: 0 })
    expect(report.items).toHaveLength(1)
    expect(report.items[0]).toMatchObject({ proposal_id: row.id, action: 'reverted' })
    // the graph really was inverted, not just the queue row relabelled
    expect(edgeBetween(db, source, target, 'develops')).toBe(false)
    assertRolledBack(db, row.id)
  })

  test('the run is findable by the synthesized id before confirming anything (dry-run preview)', () => {
    const db = getDb()
    const { source, target } = activePair(db, 'ac2-preview')
    const row = insertPendingEdge(db, source, target, 'develops')
    const runId = expectSynthesizedRunId(applyAccepted(row.id, db).run_id)

    // Addressability itself: a preview resolves the same manifest the confirm
    // does, and previews nothing.
    const preview = rollback(runId, { now: NOW_LATER }, db)

    expect(preview.confirm).toBe(false)
    expect(preview.summary).toEqual({ reverted: 1, skipped: 0, refused: 0 })
    expect(edgeBetween(db, source, target, 'develops')).toBe(true)
    assertAccepted(db, row.id)
  })
})

// ── AC-F28-3: one shared envelope per batch ─────────────────────────────────────

describe('AC-F28-3: apply_batch shares exactly one envelope', () => {
  test('every accepted row and outcome.run_id carry the same synthesized id', () => {
    const db = getDb()
    const first = activePair(db, 'ac3-a')
    const second = activePair(db, 'ac3-b')
    const rowA = insertPendingEdge(db, first.source, first.target, 'develops')
    const rowB = insertPendingEdge(db, second.source, second.target, 'develops')

    const out = applyBatch([rowA.id, rowB.id], { confirm: true, now: NOW }, db)

    expect(out.refused).toBeUndefined()
    expect(out.errors).toHaveLength(0)
    expect(out.results).toHaveLength(2)

    const shared = expectSynthesizedRunId(out.run_id)
    // every accepted row joins the SAME envelope (D5) ...
    expect(stored(db, rowA.id).run_id).toBe(shared)
    expect(stored(db, rowB.id).run_id).toBe(shared)
    // ... and so does every stored result ...
    expect(resultRunId(db, rowA.id)).toBe(shared)
    expect(resultRunId(db, rowB.id)).toBe(shared)
    // ... and every per-item returned envelope, not just the batch outcome.
    for (const result of out.results as AcceptedApplyResult[]) {
      expect(result.status).toBe('accepted')
      expect(result.run_id).toBe(shared)
    }
  })

  test('one rollback of the shared id reverts every row of the batch', () => {
    const db = getDb()
    const first = activePair(db, 'ac3-rb-a')
    const second = activePair(db, 'ac3-rb-b')
    const rowA = insertPendingEdge(db, first.source, first.target, 'develops')
    const rowB = insertPendingEdge(db, second.source, second.target, 'develops')

    const out = applyBatch([rowA.id, rowB.id], { confirm: true, now: NOW }, db)
    const shared = expectSynthesizedRunId(out.run_id)

    const report = rollback(shared, { confirm: true, now: NOW_LATER }, db)

    // The batch IS the run: one call must invert everything it committed.
    expect(report.summary).toEqual({ reverted: 2, skipped: 0, refused: 0 })
    expect(edgeBetween(db, first.source, first.target, 'develops')).toBe(false)
    expect(edgeBetween(db, second.source, second.target, 'develops')).toBe(false)
    assertRolledBack(db, rowA.id)
    assertRolledBack(db, rowB.id)
  })
})

// ── AC-F28-4: a synthesized id can never satisfy run_id_required ───────────────

describe('AC-F28-4: a triage confirm without a caller run_id stays refused', () => {
  test('triage_activate is refused and no id is written anywhere', () => {
    const db = getDb()
    const source = seedThought({ id: 'ac4-src', content: 'draft src', status: 'draft', created_at: NOW })
    const row = insertPendingTriage(db, 'triage_activate', source)

    const out = applyProposal(row.id, { confirm: true, now: NOW }, db)

    expect(out.status).toBe('refused')
    expect((out as { refusal: { code: string } }).refusal.code).toBe('run_id_required')
    // Nothing was written: no column, no result JSON, no envelope key.
    const after = stored(db, row.id)
    expect(after.run_id).toBeNull()
    expect(after.result).toBeNull()
    expect(after.decided_at).toBeNull()
    expect('run_id' in out).toBe(false)
    assertStillPending(db, row.id)
  })

  test('triage_archive is refused too, and the draft is untouched', () => {
    const db = getDb()
    const source = seedThought({ id: 'ac4-arc-src', content: 'draft src', status: 'draft', created_at: NOW })
    const target = seedThought({ id: 'ac4-arc-tgt', content: 'dup tgt', created_at: NOW })
    const row = insertPendingTriage(db, 'triage_archive', source, target)

    const out = applyProposal(row.id, { confirm: true, now: NOW }, db)

    expect(out.status).toBe('refused')
    expect((out as { refusal: { code: string } }).refusal.code).toBe('run_id_required')
    expect(stored(db, row.id).run_id).toBeNull()
    assertStillPending(db, row.id)
  })

  test('a batch mixing a pending triage row refuses whole and synthesizes nothing', () => {
    const db = getDb()
    const source = seedThought({ id: 'ac4-mix-src', content: 'draft src', status: 'draft', created_at: NOW })
    const { source: edgeSource, target: edgeTarget } = activePair(db, 'ac4-mix')
    const triageRow = insertPendingTriage(db, 'triage_activate', source)
    const edgeRow = insertPendingEdge(db, edgeSource, edgeTarget, 'develops')

    const out = applyBatch([triageRow.id, edgeRow.id], { confirm: true, now: NOW }, db)

    // The guard runs before the batch envelope is minted (D4/D5 order).
    expect(out.refused?.code).toBe('run_id_required')
    expect(out.results).toEqual([])
    expect('run_id' in out).toBe(false)
    expect(stored(db, triageRow.id).run_id).toBeNull()
    expect(stored(db, edgeRow.id).run_id).toBeNull()
    assertStillPending(db, triageRow.id)
    assertStillPending(db, edgeRow.id)
    expect(edgeBetween(db, edgeSource, edgeTarget, 'develops')).toBe(false)
  })
})

// ── AC-F28-5: a caller-supplied id is never overridden ─────────────────────────

describe('AC-F28-5: a caller-supplied run_id is used verbatim', () => {
  test('row, stored result and returned envelope all carry the caller id', () => {
    const db = getDb()
    const { source, target } = activePair(db, 'ac5')
    const row = insertPendingEdge(db, source, target, 'develops')

    const out = applyAccepted(row.id, db, 'run-caller-42')

    expect(out.run_id).toBe('run-caller-42')
    expect(stored(db, row.id).run_id).toBe('run-caller-42')
    expect(resultRunId(db, row.id)).toBe('run-caller-42')
  })

  test('a caller id that looks synthesized is still taken verbatim (prefix is advisory, D2)', () => {
    const db = getDb()
    const { source, target } = activePair(db, 'ac5-auto')
    const row = insertPendingEdge(db, source, target, 'develops')
    const callerId = 'auto-not-really-synthesized'

    const out = applyAccepted(row.id, db, callerId)

    // Provenance is advisory: a caller may legitimately choose the same prefix.
    expect(out.run_id).toBe(callerId)
    expect(stored(db, row.id).run_id).toBe(callerId)
    expect(resultRunId(db, row.id)).toBe(callerId)
    // and it is a plain passthrough, not a re-mint
    expect(out.run_id).not.toMatch(AUTO_ID)
  })

  test('a batch with a caller run_id shares the caller id, not a synthesized one', () => {
    const db = getDb()
    const first = activePair(db, 'ac5-b-a')
    const second = activePair(db, 'ac5-b-b')
    const rowA = insertPendingEdge(db, first.source, first.target, 'develops')
    const rowB = insertPendingEdge(db, second.source, second.target, 'develops')

    const out = applyBatch([rowA.id, rowB.id], { confirm: true, now: NOW, runId: 'run-batch-caller' }, db)

    expect(out.run_id).toBe('run-batch-caller')
    expect(stored(db, rowA.id).run_id).toBe('run-batch-caller')
    expect(stored(db, rowB.id).run_id).toBe('run-batch-caller')
  })
})

// ── AC-F28-6: a preview never mints an envelope ────────────────────────────────

describe('AC-F28-6: confirm:false writes no run_id and leaves the row pending', () => {
  test('a single dry-run returns no run_id and does not touch the row', () => {
    const db = getDb()
    const { source, target } = activePair(db, 'ac6')
    const row = insertPendingEdge(db, source, target, 'develops')

    const out = applyProposal(row.id, { now: NOW }, db)

    expect(out.status).toBe('dry_run')
    expect('run_id' in out).toBe(false)
    const after = stored(db, row.id)
    expect(after.run_id).toBeNull()
    expect(after.result).toBeNull()
    expect(after.decided_at).toBeNull()
    assertStillPending(db, row.id)
    expect(edgeBetween(db, source, target, 'develops')).toBe(false)
  })

  test('an explicit confirm:false behaves the same as the default', () => {
    const db = getDb()
    const { source, target } = activePair(db, 'ac6-exp')
    const row = insertPendingEdge(db, source, target, 'develops')

    const out = applyProposal(row.id, { confirm: false, now: NOW }, db)

    expect(out.status).toBe('dry_run')
    expect('run_id' in out).toBe(false)
    expect(stored(db, row.id).run_id).toBeNull()
    assertStillPending(db, row.id)
  })

  test('a dry-run batch synthesizes nothing and reports no run_id', () => {
    const db = getDb()
    const first = activePair(db, 'ac6-b-a')
    const second = activePair(db, 'ac6-b-b')
    const rowA = insertPendingEdge(db, first.source, first.target, 'develops')
    const rowB = insertPendingEdge(db, second.source, second.target, 'develops')

    const out = applyBatch([rowA.id, rowB.id], { now: NOW }, db)

    expect('run_id' in out).toBe(false)
    expect(out.results.map(r => r.status)).toEqual(['dry_run', 'dry_run'])
    expect(stored(db, rowA.id).run_id).toBeNull()
    expect(stored(db, rowB.id).run_id).toBeNull()
    assertStillPending(db, rowA.id)
    assertStillPending(db, rowB.id)
  })
})

// ── AC-F28-7: an idempotent accept still joins the manifest ────────────────────

describe('AC-F28-7: an idempotent accept is recorded, and rolls back as skipped', () => {
  /** An `edge` row whose requested graph state already holds. */
  function alreadyAppliedEdgeRow(db: Database, prefix: string): { id: string; source: string; target: string } {
    const { source, target } = activePair(db, prefix)
    seedEdge(source, target, 'develops')
    return { id: insertPendingEdge(db, source, target, 'develops').id, source, target }
  }

  test('the idempotent row records the synthesized id and the idempotent flag', () => {
    const db = getDb()
    const row = alreadyAppliedEdgeRow(db, 'ac7')

    const out = applyAccepted(row.id, db)

    expect(out.idempotent).toBe(true)
    const id = expectSynthesizedRunId(out.run_id)
    expect(stored(db, row.id).run_id).toBe(id)
    // The `idempotent: true` marker is what makes rollback skip instead of revert.
    const result = storedResult(db, row.id)
    expect(result.idempotent).toBe(true)
    expect(result.run_id).toBe(id)
    assertAccepted(db, row.id)
  })

  test('rollback of that run reports the row skipped and never reverts', () => {
    const db = getDb()
    const row = alreadyAppliedEdgeRow(db, 'ac7-skip')

    const runId = expectSynthesizedRunId(applyAccepted(row.id, db).run_id)

    // In-window clock, otherwise the F-14 window guard refuses first and the
    // `skipped` branch is never reached (windowRefusal runs before idempotency).
    const report = rollback(runId, { confirm: true, now: NOW_LATER }, db)

    expect(report.summary).toEqual({ reverted: 0, skipped: 1, refused: 0 })
    expect(report.items[0]).toMatchObject({ proposal_id: row.id, action: 'skipped' })
    // nothing was inverted: the edge the row "re-applied" is untouched
    expect(edgeBetween(db, row.source, row.target, 'develops')).toBe(true)
    assertAccepted(db, row.id)
  })
})

// ── AC-F28-8: regression — enveloped applies are unchanged ─────────────────────

describe('AC-F28-8: applies that already supply a run_id are unchanged', () => {
  test('a caller-enveloped edge apply keeps its result payload and gains only run_id', () => {
    const db = getDb()
    const { source, target } = activePair(db, 'ac8')
    const row = insertPendingEdge(db, source, target, 'develops')

    applyAccepted(row.id, db, 'run-legacy-7')

    // The pre-existing payload is untouched; the envelope is purely additive
    // (D6: the column is the rollback key, `result.run_id` is audit only).
    const result = storedResult(db, row.id)
    expect(typeof result.edge_id).toBe('string')
    expect(result.run_id).toBe('run-legacy-7')
    expect(Object.keys(result).sort()).toEqual(['edge_id', 'run_id'])
    expect(stored(db, row.id).applied_at).toBe(NOW)
    expect(stored(db, row.id).decided_at).toBe(NOW)
  })

  test('a caller-enveloped idempotent accept keeps the idempotent payload shape', () => {
    const db = getDb()
    const { source, target } = activePair(db, 'ac8-idem')
    seedEdge(source, target, 'develops')
    const row = insertPendingEdge(db, source, target, 'develops')

    const out = applyAccepted(row.id, db, 'run-legacy-8')

    expect(out.idempotent).toBe(true)
    const result = storedResult(db, row.id)
    expect(result.idempotent).toBe(true)
    expect(result.run_id).toBe('run-legacy-8')
    // The idempotent branch never wrote an edge_id, and still does not.
    expect(Object.keys(result).sort()).toEqual(['idempotent', 'run_id'])
  })
})

// ── batch envelope edge cases (spec §4.6) ──────────────────────────────────────

describe('apply_batch: envelope edge cases', () => {
  test('a batch that accepted nothing reports no run_id (no empty manifest handed back)', () => {
    const db = getDb()
    // Archived target → the gate reports stale, so no row joins the envelope.
    const first = activePair(db, 'edge-a')
    const second = activePair(db, 'edge-b')
    for (const target of [first.target, second.target]) {
      db.prepare("UPDATE thoughts SET status = 'archived' WHERE id = ?").run(target)
    }
    const rowA = insertPendingEdge(db, first.source, first.target, 'develops')
    const rowB = insertPendingEdge(db, second.source, second.target, 'develops')

    const out = applyBatch([rowA.id, rowB.id], { confirm: true, now: NOW }, db)

    expect(out.results.map(r => r.status)).toEqual(['stale', 'stale'])
    // An id with an empty manifest would send the caller after a run that
    // committed nothing, so it is not reported.
    expect('run_id' in out).toBe(false)
    expect(stored(db, rowA.id).run_id).toBeNull()
    expect(stored(db, rowB.id).run_id).toBeNull()
  })

  test('an already-accepted triage row keeps its own envelope and is not re-grouped', () => {
    const db = getDb()
    const source = seedThought({ id: 'mix-src', content: 'draft src', status: 'draft', created_at: NOW })
    const triageRow = insertPendingTriage(db, 'triage_activate', source)
    applyAccepted(triageRow.id, db, 'run-triage-prior')
    const { source: edgeSource, target: edgeTarget } = activePair(db, 'mix-edge')
    const edgeRow = insertPendingEdge(db, edgeSource, edgeTarget, 'develops')

    const out = applyBatch([triageRow.id, edgeRow.id], { confirm: true, now: NOW }, db)

    const shared = expectSynthesizedRunId(out.run_id)
    // The shared id goes only to the pending non-triage row ...
    expect(stored(db, edgeRow.id).run_id).toBe(shared)
    // ... and a row already accepted under another run is never re-grouped.
    expect(stored(db, triageRow.id).run_id).toBe('run-triage-prior')
    expect((out.results[0] as AcceptedApplyResult).run_id).toBe('run-triage-prior')
    expect((out.results[1] as AcceptedApplyResult).run_id).toBe(shared)
  })

  test('a batch of only already-accepted rows reports no run_id', () => {
    const db = getDb()
    const { source, target } = activePair(db, 'only-accepted')
    const row = insertPendingEdge(db, source, target, 'develops')
    const first = expectSynthesizedRunId(applyAccepted(row.id, db).run_id)

    const out = applyBatch([row.id], { confirm: true, now: NOW_LATER }, db)

    // Nothing new was decided, so no envelope is minted; the echo still reports
    // the run the row was originally accepted under.
    expect('run_id' in out).toBe(false)
    expect((out.results[0] as AcceptedApplyResult).run_id).toBe(first)
    expect(stored(db, row.id).run_id).toBe(first)
  })
})

// ── compile-time contract ──────────────────────────────────────────────────────

describe('response typing', () => {
  test('an accepted result always declares run_id; a dry-run never does', () => {
    const db = getDb()
    const { source, target } = activePair(db, 'types')
    const row = insertPendingEdge(db, source, target, 'develops')

    const out: ApplyResult = applyProposal(row.id, { now: NOW }, db)
    // A dry-run result type carries no `run_id` key at all, so reading it is a
    // type error — the guarantee is structural, not just a missing value.
    expect(out.status === 'dry_run' && 'run_id' in out).toBe(false)

    const batch: ApplyBatchOutcome = applyBatch([], { now: NOW }, db)
    expect(batch.results).toEqual([])
  })
})
