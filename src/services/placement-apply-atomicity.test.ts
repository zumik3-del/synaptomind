import { afterEach, beforeEach, expect, test } from 'bun:test'
import type { Database } from 'bun:sqlite'
import { closeDb, getDb } from '../db'
import { createTestDb, seedThought } from '../test/helpers'
import { insertPendingEdge, NOW } from '../test/proposal-apply-helpers'
import { applyBatchService } from './placement-apply.service'

beforeEach(createTestDb)
afterEach(closeDb)

const RUN_ID = 'run-atomicity-1'

function proposalState(db: Database, id: string): { state: string; run_id: string | null } {
  const row = db.prepare('SELECT state, run_id FROM placement_proposals WHERE id = ?').get(id) as
    | { state: string; run_id: string | null }
    | undefined
  if (!row) throw new Error(`proposal '${id}' not found`)
  return row
}

function edgeCount(db: Database, source: string, target: string): number {
  const row = db
    .prepare('SELECT COUNT(*) AS n FROM edges WHERE source_id = ? AND target_id = ?')
    .get(source, target) as { n: number }
  return row.n
}

function pair(prefix: string): { source: string; target: string } {
  return {
    source: seedThought({ id: `${prefix}-s`, content: `${prefix} source text` }),
    target: seedThought({ id: `${prefix}-t`, content: `${prefix} target text` })
  }
}

test('a failing item does not roll back its siblings in the run', () => {
  const db = getDb()
  const first = pair('atomic-a')
  const second = pair('atomic-b')
  const rowA = insertPendingEdge(db, first.source, first.target, 'develops')
  const rowB = insertPendingEdge(db, second.source, second.target, 'develops')
  db.run(
    `CREATE TRIGGER probe_block_item BEFORE INSERT ON edges
     WHEN NEW.source_id = '${second.source}'
     BEGIN SELECT RAISE(ABORT, 'probe: item blocked'); END`
  )

  const out = applyBatchService([rowA.id, rowB.id], { confirm: true, now: NOW, runId: RUN_ID }, db)

  expect(out.results.map(result => result.status)).toEqual(['accepted', 'failed'])
  expect(out.results[1]).toMatchObject({ proposal_id: rowB.id, reason: 'probe: item blocked' })
  expect(out.errors).toEqual([])
  expect(out.run_id).toBe(RUN_ID)
  expect(edgeCount(db, first.source, first.target)).toBe(1)
  expect(edgeCount(db, second.source, second.target)).toBe(0)
  expect(proposalState(db, rowA.id)).toEqual({ state: 'accepted', run_id: RUN_ID })
  expect(proposalState(db, rowB.id).run_id).toBeNull()
})

test('a run-level failure leaves no partially applied run under the run_id', () => {
  const db = getDb()
  const first = pair('atomic-run-a')
  const second = pair('atomic-run-b')
  const rowA = insertPendingEdge(db, first.source, first.target, 'develops')
  const rowB = insertPendingEdge(db, second.source, second.target, 'develops')
  db.run(
    `CREATE TRIGGER probe_abort_run BEFORE INSERT ON edges
     WHEN NEW.source_id = '${second.source}'
     BEGIN SELECT RAISE(ROLLBACK, 'probe: run aborted'); END`
  )

  expect(() =>
    applyBatchService([rowA.id, rowB.id], { confirm: true, now: NOW, runId: RUN_ID }, db)
  ).toThrow()

  expect(edgeCount(db, first.source, first.target)).toBe(0)
  expect(edgeCount(db, second.source, second.target)).toBe(0)
  expect(proposalState(db, rowA.id)).toEqual({ state: 'pending', run_id: null })
  expect(proposalState(db, rowB.id)).toEqual({ state: 'pending', run_id: null })
})
