import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import type { Database } from 'bun:sqlite'
import { config } from '../config'
import { closeDb, getDb } from '../db'
import { getEdgePairBetween } from '../db/edges'
import { insertProposal } from '../db/placement-proposals'
import { getThoughtRow } from '../db/thoughts'
import { createTestDb, seedThought } from '../test/helpers'
import {
  assertAccepted,
  assertRolledBack,
  NOW,
  NOW_LATER,
  PAST,
  pairFingerprint,
  RUN_ID
} from '../test/proposal-apply-helpers'
import { applyProposalService } from './placement-apply.service'
import { rollbackService } from './placement-rollback.service'
import type { RollbackItemReport, RollbackReport } from './placement-apply.types'

beforeEach(createTestDb)
afterEach(closeDb)

const DAY_MS = 86_400_000
const DEFAULT_TTL_DAYS = 30
const ANCIENT = '2000-01-01T00:00:00.000Z'

function withPlacementConfig(overrides: Partial<typeof config.placement>, fn: () => void): void {
  const saved = config.placement
  config.placement = { ...saved, ...overrides }
  try {
    fn()
  } finally {
    config.placement = saved
  }
}

function cutoffFor(now: string, ttlDays = config.placement.proposalTtlDays): string {
  return new Date(Date.parse(now) - ttlDays * DAY_MS).toISOString()
}

function beforeCutoffFor(now: string, ttlDays = config.placement.proposalTtlDays): string {
  return new Date(Date.parse(cutoffFor(now, ttlDays)) - 1).toISOString()
}

/**
 * Age an accepted row in place, leaving every other column the apply path wrote.
 * `updateProposalState` cannot do this: it writes omitted fields as NULL, which
 * would drop `applied_at` (the manifest order key) and the `result` JSON that
 * `decideRollback` reads for `idempotent` / `edge_id`.
 */
function setDecidedAt(db: Database, id: string, decidedAt: string | null): void {
  const { changes } = db
    .prepare('UPDATE placement_proposals SET decided_at = ? WHERE id = ?')
    .run(decidedAt, id)
  if (changes === 0) throw new Error(`proposal '${id}' not found`)
}

function rowOf(db: Database, id: string): { state: string; decided_at: string | null } {
  const row = db
    .prepare('SELECT state, decided_at FROM placement_proposals WHERE id = ?')
    .get(id) as { state: string; decided_at: string | null } | undefined
  if (!row) throw new Error(`proposal '${id}' not found`)
  return row
}

function itemFor(report: RollbackReport, proposalId: string): RollbackItemReport {
  const item = report.items.find(i => i.proposal_id === proposalId)
  if (!item)
    throw new Error(
      `no report item for '${proposalId}': ${report.items.map(i => i.proposal_id).join(', ')}`
    )
  return item
}

function graphCounts(db: Database): { thoughts: number; edges: number } {
  return {
    thoughts: (db.prepare('SELECT COUNT(*) AS n FROM thoughts').get() as { n: number }).n,
    edges: (db.prepare('SELECT COUNT(*) AS n FROM edges').get() as { n: number }).n
  }
}

interface AcceptedEdge {
  rowId: string
  source: string
  target: string
}

function acceptedEdgeRow(db: Database, id: string): AcceptedEdge {
  const source = seedThought({
    id: `${id}-s`,
    content: `${id} source content`,
    status: 'active',
    created_at: NOW
  })
  const target = seedThought({
    id: `${id}-t`,
    content: `${id} target content`,
    status: 'active',
    created_at: PAST
  })
  const row = insertProposal(db, {
    project_id: 'default',
    source_thought_id: source,
    item_kind: 'edge',
    target_id: target,
    edge_type: 'related',
    lifecycle_action: null,
    direction: 'symmetric',
    confidence: 0.8,
    rationale: 'F-14 regression matrix',
    payload: '{}',
    fingerprint: pairFingerprint(db, source, target)
  })
  const out = applyProposalService(
    row.id,
    { confirm: true, now: NOW, runId: RUN_ID, decidedBy: 'tester' },
    db
  )
  expect(out.status).toBe('accepted')
  assertAccepted(db, row.id)
  return { rowId: row.id, source, target }
}

function edgeHeld(db: Database, pair: AcceptedEdge): boolean {
  return getEdgePairBetween(db, pair.source, pair.target) !== null
}

describe('F-14 AC-1: rollback window refusal', () => {
  test('an accepted edge row decided outside the window is refused and not reverted', () => {
    const db = getDb()
    const pair = acceptedEdgeRow(db, 'f14-1')
    expect(edgeHeld(db, pair)).toBe(true)
    setDecidedAt(db, pair.rowId, ANCIENT)

    const report = rollbackService(RUN_ID, { confirm: true, now: NOW_LATER }, db)

    expect(itemFor(report, pair.rowId).action).toBe('refused')
    expect(report.summary).toEqual({ reverted: 0, skipped: 0, refused: 1 })
    expect(edgeHeld(db, pair)).toBe(true)
    expect(rowOf(db, pair.rowId).state).toBe('accepted')
    expect(rowOf(db, pair.rowId).decided_at).toBe(ANCIENT)
  })
})

describe('F-14 AC-2: a mixed-window run', () => {
  test('the in-window row reverts and the out-of-window row is refused in the same run', () => {
    const db = getDb()
    const fresh = acceptedEdgeRow(db, 'f14-2-fresh')
    const stale = acceptedEdgeRow(db, 'f14-2-stale')
    setDecidedAt(db, stale.rowId, ANCIENT)

    const report = rollbackService(RUN_ID, { confirm: true, now: NOW_LATER }, db)

    expect(report.summary).toEqual({ reverted: 1, skipped: 0, refused: 1 })
    expect(itemFor(report, fresh.rowId).action).toBe('reverted')
    expect(itemFor(report, stale.rowId).action).toBe('refused')
    expect(edgeHeld(db, fresh)).toBe(false)
    assertRolledBack(db, fresh.rowId)
    expect(edgeHeld(db, stale)).toBe(true)
    assertAccepted(db, stale.rowId)
  })
})

describe('F-14 AC-3: dry-run of an out-of-window row', () => {
  test('the reason names the window and the cutoff, and no state changes', () => {
    const db = getDb()
    const pair = acceptedEdgeRow(db, 'f14-3')
    setDecidedAt(db, pair.rowId, ANCIENT)
    const before = graphCounts(db)

    const report = rollbackService(RUN_ID, { confirm: false, now: NOW_LATER }, db)

    expect(report.confirm).toBe(false)
    expect(itemFor(report, pair.rowId).action).toBe('refused')
    expect(itemFor(report, pair.rowId).reason).toContain('rollback window')
    expect(itemFor(report, pair.rowId).reason).toContain(cutoffFor(NOW_LATER))
    expect(report.summary).toEqual({ reverted: 0, skipped: 0, refused: 1 })
    expect(graphCounts(db)).toEqual(before)
    expect(edgeHeld(db, pair)).toBe(true)
    assertAccepted(db, pair.rowId)
  })

  test('an all-out-of-window run reports reverted:0 and refuses every row', () => {
    const db = getDb()
    const first = acceptedEdgeRow(db, 'f14-3-all-a')
    const second = acceptedEdgeRow(db, 'f14-3-all-b')
    setDecidedAt(db, first.rowId, ANCIENT)
    setDecidedAt(db, second.rowId, ANCIENT)

    const report = rollbackService(RUN_ID, { confirm: false, now: NOW_LATER }, db)

    expect(report.summary).toEqual({ reverted: 0, skipped: 0, refused: 2 })
    expect(report.items.every(i => i.action === 'refused')).toBe(true)
    expect(edgeHeld(db, first)).toBe(true)
    expect(edgeHeld(db, second)).toBe(true)
  })
})

describe('F-14 AC-4: window boundary', () => {
  test('decided_at exactly at now - ttlDays*86400000 is in-window and reverts', () => {
    const db = getDb()
    const pair = acceptedEdgeRow(db, 'f14-4-at')
    setDecidedAt(db, pair.rowId, cutoffFor(NOW))

    const report = rollbackService(RUN_ID, { confirm: true, now: NOW }, db)

    expect(itemFor(report, pair.rowId).action).toBe('reverted')
    expect(report.summary).toEqual({ reverted: 1, skipped: 0, refused: 0 })
    expect(edgeHeld(db, pair)).toBe(false)
    assertRolledBack(db, pair.rowId)
  })

  test('decided_at one millisecond before the cutoff is refused', () => {
    const db = getDb()
    const pair = acceptedEdgeRow(db, 'f14-4-before')
    setDecidedAt(db, pair.rowId, beforeCutoffFor(NOW))

    const report = rollbackService(RUN_ID, { confirm: true, now: NOW }, db)

    expect(itemFor(report, pair.rowId).action).toBe('refused')
    expect(report.summary).toEqual({ reverted: 0, skipped: 0, refused: 1 })
    expect(edgeHeld(db, pair)).toBe(true)
    assertAccepted(db, pair.rowId)
  })

  test('the boundary is computed from the configured TTL, not a hardcoded 30', () => {
    expect(config.placement.proposalTtlDays).toBe(DEFAULT_TTL_DAYS)
    expect(cutoffFor(NOW)).toBe(new Date(Date.parse(NOW) - DEFAULT_TTL_DAYS * DAY_MS).toISOString())
  })
})

describe('F-14 AC-5: unmeasurable decided_at', () => {
  const FAIL_CLOSED_REASON = 'accepted row has no decided_at; cannot verify the rollback window'

  test('an accepted row with decided_at === null is refused, not reverted', () => {
    const db = getDb()
    const pair = acceptedEdgeRow(db, 'f14-5-null')
    setDecidedAt(db, pair.rowId, null)

    const report = rollbackService(RUN_ID, { confirm: true, now: NOW_LATER }, db)

    expect(itemFor(report, pair.rowId).action).toBe('refused')
    expect(itemFor(report, pair.rowId).reason).toBe(FAIL_CLOSED_REASON)
    expect(report.summary).toEqual({ reverted: 0, skipped: 0, refused: 1 })
    expect(edgeHeld(db, pair)).toBe(true)
    expect(rowOf(db, pair.rowId).state).toBe('accepted')
    expect(rowOf(db, pair.rowId).decided_at).toBeNull()
  })

  test('an accepted row with an unparseable decided_at is refused, not reverted', () => {
    const db = getDb()
    const pair = acceptedEdgeRow(db, 'f14-5-bad')
    setDecidedAt(db, pair.rowId, 'not-a-timestamp')

    const report = rollbackService(RUN_ID, { confirm: true, now: NOW_LATER }, db)

    expect(itemFor(report, pair.rowId).action).toBe('refused')
    expect(itemFor(report, pair.rowId).reason).toBe(FAIL_CLOSED_REASON)
    expect(report.summary).toEqual({ reverted: 0, skipped: 0, refused: 1 })
    expect(edgeHeld(db, pair)).toBe(true)
    assertAccepted(db, pair.rowId)
  })

  test('an unparseable rollback clock fails closed instead of throwing', () => {
    const db = getDb()
    const pair = acceptedEdgeRow(db, 'f14-5-now')

    const report = rollbackService(RUN_ID, { confirm: true, now: 'not-a-clock' }, db)

    expect(itemFor(report, pair.rowId).action).toBe('refused')
    expect(itemFor(report, pair.rowId).reason).toContain('cannot verify the rollback window')
    expect(edgeHeld(db, pair)).toBe(true)
    assertAccepted(db, pair.rowId)
  })
})

describe('F-14 AC-6: proposalTtlDays < 0 disables the guard', () => {
  test('the same row refused at the default TTL reverts once retention is disabled', () => {
    const db = getDb()
    const pair = acceptedEdgeRow(db, 'f14-6')
    setDecidedAt(db, pair.rowId, ANCIENT)

    const guarded = rollbackService(RUN_ID, { confirm: true, now: NOW_LATER }, db)
    expect(guarded.items[0].action).toBe('refused')
    expect(edgeHeld(db, pair)).toBe(true)

    withPlacementConfig({ proposalTtlDays: -1 }, () => {
      const report = rollbackService(RUN_ID, { confirm: true, now: NOW_LATER }, db)

      expect(itemFor(report, pair.rowId).action).toBe('reverted')
      expect(report.summary).toEqual({ reverted: 1, skipped: 0, refused: 0 })
      expect(edgeHeld(db, pair)).toBe(false)
      assertRolledBack(db, pair.rowId)
    })
  })

  test('proposalTtlDays === 0 is the valid extreme: only decided_at >= now survives', () => {
    const db = getDb()
    const older = acceptedEdgeRow(db, 'f14-6-zero-a')
    const exact = acceptedEdgeRow(db, 'f14-6-zero-b')
    setDecidedAt(db, older.rowId, beforeCutoffFor(NOW_LATER, 0))
    setDecidedAt(db, exact.rowId, NOW_LATER)

    withPlacementConfig({ proposalTtlDays: 0 }, () => {
      const report = rollbackService(RUN_ID, { confirm: true, now: NOW_LATER }, db)

      expect(itemFor(report, older.rowId).action).toBe('refused')
      expect(itemFor(report, exact.rowId).action).toBe('reverted')
      expect(report.summary).toEqual({ reverted: 1, skipped: 0, refused: 1 })
      expect(edgeHeld(db, older)).toBe(true)
      expect(edgeHeld(db, exact)).toBe(false)
    })
  })
})

describe('F-14 guard order', () => {
  test('a row that is both out-of-window and fingerprint-drifted is refused for the window', () => {
    const db = getDb()
    const pair = acceptedEdgeRow(db, 'f14-order')
    setDecidedAt(db, pair.rowId, ANCIENT)
    db.prepare("UPDATE thoughts SET updated_at = '2099-01-01T00:00:00.000Z' WHERE id = ?").run(
      pair.source
    )

    const report = rollbackService(RUN_ID, { confirm: true, now: NOW_LATER }, db)

    expect(itemFor(report, pair.rowId).action).toBe('refused')
    expect(itemFor(report, pair.rowId).reason).toContain('rollback window')
    expect(itemFor(report, pair.rowId).reason).not.toContain('fingerprint')
    expect(edgeHeld(db, pair)).toBe(true)
    assertAccepted(db, pair.rowId)
  })
})

describe('F-14 AC-8: in-window behaviour is unchanged', () => {
  test('every reversible row still reverts while in-window', () => {
    const db = getDb()
    const first = acceptedEdgeRow(db, 'f14-8-edge')
    const second = acceptedEdgeRow(db, 'f14-8-edge2')
    const rows = [first.rowId, second.rowId]

    expect(edgeHeld(db, first)).toBe(true)
    expect(edgeHeld(db, second)).toBe(true)
    const edgesAfterApply = graphCounts(db).edges

    const report = rollbackService(RUN_ID, { confirm: true, now: NOW_LATER }, db)

    expect(report.summary).toEqual({ reverted: 2, skipped: 0, refused: 0 })
    for (const id of rows) expect(itemFor(report, id).action).toBe('reverted')
    expect(graphCounts(db).edges).toBe(edgesAfterApply - 2)
    for (const id of rows) assertRolledBack(db, id)
  })

  test('a removed-kind row is refused with a typed reason, and the window does not shadow it', () => {
    const db = getDb()
    const source = seedThought({
      id: 'f14-8-merge-s',
      content: 'matrix merge src',
      status: 'active',
      created_at: NOW
    })
    const target = seedThought({
      id: 'f14-8-merge-t',
      content: 'matrix merge tgt',
      status: 'active',
      created_at: PAST
    })
    const mergeRowId = 'row-f14-8-merge'
    db.prepare(`
      INSERT INTO placement_proposals
        (id, project_id, source_thought_id, item_kind, target_id, edge_type, lifecycle_action, direction,
         confidence, rationale, rule_id, payload, fingerprint, state, created_at, run_id, decided_at, applied_at, result)
      VALUES (?, 'default', ?, 'triage_activate', null, null, null, null,
              0.9, 'retired triage verdict', null, '{}', 'merge-fp', 'accepted', ?, ?, ?, ?, ?)
    `).run(mergeRowId, source, NOW, RUN_ID, NOW, NOW, JSON.stringify({ idempotent: false }))
    const edgesBefore = graphCounts(db).edges

    const report = rollbackService(RUN_ID, { confirm: true, now: NOW_LATER }, db)

    expect(report.summary).toEqual({ reverted: 0, skipped: 0, refused: 1 })
    expect(itemFor(report, mergeRowId).action).toBe('refused')
    expect(itemFor(report, mergeRowId).reason).toContain('no longer supported')
    expect(itemFor(report, mergeRowId).reason).not.toContain('rollback window')
    expect(getThoughtRow(db, source)!.status).toBe('active')
    expect(getThoughtRow(db, target)!.status).toBe('active')
    expect(graphCounts(db).edges).toBe(edgesBefore)
    assertAccepted(db, mergeRowId)
  })
})
