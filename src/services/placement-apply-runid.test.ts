import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import type { Database } from 'bun:sqlite'
import { closeDb, getDb } from '../db'
import { createTestDb, seedEdge, seedThought } from '../test/helpers'
import {
  assertAccepted,
  assertRolledBack,
  assertStillPending,
  insertPendingEdge,
  NOW,
  NOW_LATER
} from '../test/proposal-apply-helpers'
import { applyBatchService, applyProposalService } from './placement-apply.service'
import type { AcceptedApplyResult, ApplyBatchOutcome, ApplyResult } from './placement-apply.types'
import { rollbackService } from './placement-rollback.service'

beforeEach(createTestDb)
afterEach(closeDb)

const AUTO_ID = /^auto-[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/

interface StoredProposal {
  state: string
  run_id: string | null
  result: string | null
  decided_at: string | null
  applied_at: string | null
}

function stored(db: Database, id: string): StoredProposal {
  const row = db
    .prepare(
      'SELECT state, run_id, result, decided_at, applied_at FROM placement_proposals WHERE id = ?'
    )
    .get(id) as StoredProposal | undefined
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

function expectSynthesizedRunId(value: string | null | undefined): string {
  expect(typeof value).toBe('string')
  expect(value).not.toBeNull()
  expect(value!.startsWith('auto-')).toBe(true)
  return value as string
}

function applyAccepted(id: string, db: Database, runId?: string): AcceptedApplyResult {
  const out = applyProposalService(
    id,
    { confirm: true, now: NOW, ...(runId === undefined ? {} : { runId }) },
    db
  )
  expect(out.status).toBe('accepted')
  return out as AcceptedApplyResult
}

function activePair(_db: Database, prefix: string): { source: string; target: string } {
  return {
    source: seedThought({ id: `${prefix}-s`, content: `${prefix} source`, created_at: NOW }),
    target: seedThought({ id: `${prefix}-t`, content: `${prefix} target`, created_at: NOW })
  }
}

function edgeBetween(db: Database, source: string, target: string, type: string): boolean {
  return (
    db
      .prepare('SELECT id FROM edges WHERE source_id = ? AND target_id = ? AND type = ?')
      .get(source, target, type) !== null
  )
}

describe('AC-F28-1: single apply without a caller run_id', () => {
  test('row, stored result and returned envelope all carry the same synthesized id', () => {
    const db = getDb()
    const { source, target } = activePair(db, 'ac1')
    const row = insertPendingEdge(db, source, target, 'develops')

    const out = applyAccepted(row.id, db)

    const id = expectSynthesizedRunId(out.run_id)
    expect(stored(db, row.id).run_id).toBe(id)
    expect(resultRunId(db, row.id)).toBe(id)
    expect(out.result).not.toBeNull()
    expect((JSON.parse(out.result!) as Record<string, unknown>).run_id).toBe(id)
    assertAccepted(db, row.id)
    expect(edgeBetween(db, source, target, 'develops')).toBe(true)
  })

  test('the synthesized id is an auto- prefixed UUIDv7 (D2 format)', () => {
    const db = getDb()
    const { source, target } = activePair(db, 'ac1-fmt')
    const row = insertPendingEdge(db, source, target, 'develops')

    const out = applyAccepted(row.id, db)

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

    expect(a).not.toBe(b)
  })

  test('re-applying the accepted row echoes the same envelope instead of minting a new one', () => {
    const db = getDb()
    const { source, target } = activePair(db, 'ac1-again')
    const row = insertPendingEdge(db, source, target, 'develops')
    const first = expectSynthesizedRunId(applyAccepted(row.id, db).run_id)

    const again = applyProposalService(
      row.id,
      { confirm: true, now: NOW_LATER },
      db
    ) as AcceptedApplyResult

    expect(again.status).toBe('accepted')
    expect(again.idempotent).toBe(true)
    expect(again.run_id).toBe(first)
    expect(stored(db, row.id).run_id).toBe(first)
  })
})

describe('AC-F28-2: rollback of the synthesized envelope reverts the row', () => {
  test('apply un-enveloped, then rollback that id, actually reverts the graph', () => {
    const db = getDb()
    const { source, target } = activePair(db, 'ac2')
    const row = insertPendingEdge(db, source, target, 'develops')

    const runId = expectSynthesizedRunId(applyAccepted(row.id, db).run_id)
    expect(edgeBetween(db, source, target, 'develops')).toBe(true)

    const report = rollbackService(runId, { confirm: true, now: NOW_LATER }, db)

    expect(report.summary).toEqual({ reverted: 1, skipped: 0, refused: 0 })
    expect(report.items).toHaveLength(1)
    expect(report.items[0]).toMatchObject({ proposal_id: row.id, action: 'reverted' })
    expect(edgeBetween(db, source, target, 'develops')).toBe(false)
    assertRolledBack(db, row.id)
  })

  test('the run is findable by the synthesized id before confirming anything (dry-run preview)', () => {
    const db = getDb()
    const { source, target } = activePair(db, 'ac2-preview')
    const row = insertPendingEdge(db, source, target, 'develops')
    const runId = expectSynthesizedRunId(applyAccepted(row.id, db).run_id)

    const preview = rollbackService(runId, { now: NOW_LATER }, db)

    expect(preview.confirm).toBe(false)
    expect(preview.summary).toEqual({ reverted: 1, skipped: 0, refused: 0 })
    expect(edgeBetween(db, source, target, 'develops')).toBe(true)
    assertAccepted(db, row.id)
  })
})

describe('AC-F28-3: apply_batch shares exactly one envelope', () => {
  test('every accepted row and outcome.run_id carry the same synthesized id', () => {
    const db = getDb()
    const first = activePair(db, 'ac3-a')
    const second = activePair(db, 'ac3-b')
    const rowA = insertPendingEdge(db, first.source, first.target, 'develops')
    const rowB = insertPendingEdge(db, second.source, second.target, 'develops')

    const out = applyBatchService([rowA.id, rowB.id], { confirm: true, now: NOW }, db)

    expect(out.refused).toBeUndefined()
    expect(out.errors).toHaveLength(0)
    expect(out.results).toHaveLength(2)

    const shared = expectSynthesizedRunId(out.run_id)
    expect(stored(db, rowA.id).run_id).toBe(shared)
    expect(stored(db, rowB.id).run_id).toBe(shared)
    expect(resultRunId(db, rowA.id)).toBe(shared)
    expect(resultRunId(db, rowB.id)).toBe(shared)
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

    const out = applyBatchService([rowA.id, rowB.id], { confirm: true, now: NOW }, db)
    const shared = expectSynthesizedRunId(out.run_id)

    const report = rollbackService(shared, { confirm: true, now: NOW_LATER }, db)

    expect(report.summary).toEqual({ reverted: 2, skipped: 0, refused: 0 })
    expect(edgeBetween(db, first.source, first.target, 'develops')).toBe(false)
    expect(edgeBetween(db, second.source, second.target, 'develops')).toBe(false)
    assertRolledBack(db, rowA.id)
    assertRolledBack(db, rowB.id)
  })
})

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

    expect(out.run_id).toBe(callerId)
    expect(stored(db, row.id).run_id).toBe(callerId)
    expect(resultRunId(db, row.id)).toBe(callerId)
    expect(out.run_id).not.toMatch(AUTO_ID)
  })

  test('a batch with a caller run_id shares the caller id, not a synthesized one', () => {
    const db = getDb()
    const first = activePair(db, 'ac5-b-a')
    const second = activePair(db, 'ac5-b-b')
    const rowA = insertPendingEdge(db, first.source, first.target, 'develops')
    const rowB = insertPendingEdge(db, second.source, second.target, 'develops')

    const out = applyBatchService(
      [rowA.id, rowB.id],
      { confirm: true, now: NOW, runId: 'run-batch-caller' },
      db
    )

    expect(out.run_id).toBe('run-batch-caller')
    expect(stored(db, rowA.id).run_id).toBe('run-batch-caller')
    expect(stored(db, rowB.id).run_id).toBe('run-batch-caller')
  })
})

describe('AC-F28-6: confirm:false writes no run_id and leaves the row pending', () => {
  test('a single dry-run returns no run_id and does not touch the row', () => {
    const db = getDb()
    const { source, target } = activePair(db, 'ac6')
    const row = insertPendingEdge(db, source, target, 'develops')

    const out = applyProposalService(row.id, { now: NOW }, db)

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

    const out = applyProposalService(row.id, { confirm: false, now: NOW }, db)

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

    const out = applyBatchService([rowA.id, rowB.id], { now: NOW }, db)

    expect('run_id' in out).toBe(false)
    expect(out.results.map(r => r.status)).toEqual(['dry_run', 'dry_run'])
    expect(stored(db, rowA.id).run_id).toBeNull()
    expect(stored(db, rowB.id).run_id).toBeNull()
    assertStillPending(db, rowA.id)
    assertStillPending(db, rowB.id)
  })
})

describe('AC-F28-7: an idempotent accept is recorded, and rolls back as skipped', () => {
  function alreadyAppliedEdgeRow(
    db: Database,
    prefix: string
  ): { id: string; source: string; target: string } {
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
    const result = storedResult(db, row.id)
    expect(result.idempotent).toBe(true)
    expect(result.run_id).toBe(id)
    assertAccepted(db, row.id)
  })

  test('rollback of that run reports the row skipped and never reverts', () => {
    const db = getDb()
    const row = alreadyAppliedEdgeRow(db, 'ac7-skip')

    const runId = expectSynthesizedRunId(applyAccepted(row.id, db).run_id)

    const report = rollbackService(runId, { confirm: true, now: NOW_LATER }, db)

    expect(report.summary).toEqual({ reverted: 0, skipped: 1, refused: 0 })
    expect(report.items[0]).toMatchObject({ proposal_id: row.id, action: 'skipped' })
    expect(edgeBetween(db, row.source, row.target, 'develops')).toBe(true)
    assertAccepted(db, row.id)
  })
})

describe('AC-F28-8: applies that already supply a run_id are unchanged', () => {
  test('a caller-enveloped edge apply keeps its result payload and gains only run_id', () => {
    const db = getDb()
    const { source, target } = activePair(db, 'ac8')
    const row = insertPendingEdge(db, source, target, 'develops')

    applyAccepted(row.id, db, 'run-legacy-7')

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
    expect(Object.keys(result).sort()).toEqual(['idempotent', 'run_id'])
  })
})

describe('apply_batch: envelope edge cases', () => {
  test('a batch that accepted nothing reports no run_id (no empty manifest handed back)', () => {
    const db = getDb()
    const first = activePair(db, 'edge-a')
    const second = activePair(db, 'edge-b')
    for (const target of [first.target, second.target]) {
      db.prepare("UPDATE thoughts SET status = 'archived' WHERE id = ?").run(target)
    }
    const rowA = insertPendingEdge(db, first.source, first.target, 'develops')
    const rowB = insertPendingEdge(db, second.source, second.target, 'develops')

    const out = applyBatchService([rowA.id, rowB.id], { confirm: true, now: NOW }, db)

    expect(out.results.map(r => r.status)).toEqual(['stale', 'stale'])
    expect('run_id' in out).toBe(false)
    expect(stored(db, rowA.id).run_id).toBeNull()
    expect(stored(db, rowB.id).run_id).toBeNull()
  })

  test('a batch of only already-accepted rows reports no run_id', () => {
    const db = getDb()
    const { source, target } = activePair(db, 'only-accepted')
    const row = insertPendingEdge(db, source, target, 'develops')
    const first = expectSynthesizedRunId(applyAccepted(row.id, db).run_id)

    const out = applyBatchService([row.id], { confirm: true, now: NOW_LATER }, db)

    expect('run_id' in out).toBe(false)
    expect((out.results[0] as AcceptedApplyResult).run_id).toBe(first)
    expect(stored(db, row.id).run_id).toBe(first)
  })
})

describe('response typing', () => {
  test('an accepted result always declares run_id; a dry-run never does', () => {
    const db = getDb()
    const { source, target } = activePair(db, 'types')
    const row = insertPendingEdge(db, source, target, 'develops')

    const out: ApplyResult = applyProposalService(row.id, { now: NOW }, db)
    expect(out.status === 'dry_run' && 'run_id' in out).toBe(false)

    const batch: ApplyBatchOutcome = applyBatchService([], { now: NOW }, db)
    expect(batch.results).toEqual([])
  })
})
