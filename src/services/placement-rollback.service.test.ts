/**
 * F-14 rollback-window guard — coverage for the #1047 implementation (task #1049).
 *
 * `rollbackService` refuses an accepted row whose `decided_at` predates the rollback
 * window `now - placement.proposalTtlDays * 86_400_000` — the same TTL that
 * prunes the queue, so the guard is the read-time backstop for a not-yet-run or
 * slow retention job (ADR 2026-09-29 §2.8, OQ-3). The window IS the retention
 * window, a negative TTL disables both, the verdict is per row, and a refusal is
 * terminal and outranks merge / idempotent / fingerprint (spec D2-D5).
 *
 * Every case injects `now`. The window is compared against that clock and never
 * against the wall clock, so no test here can flake as the calendar moves.
 *
 * Since task #1946 `edge` is the only applicable kind, so every revertible
 * fixture is an accepted edge row.
 */
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
  RUN_ID,
} from '../test/proposal-apply-helpers'
import { applyProposalService } from './placement-apply.service'
import { rollbackService } from './placement-rollback.service'
import type { RollbackItemReport, RollbackReport } from './placement-apply.types'

beforeEach(createTestDb)
afterEach(closeDb)

const DAY_MS = 86_400_000
/** Documented default (`src/config.ts:99`); the boundary cases derive from it. */
const DEFAULT_TTL_DAYS = 30
/** Old enough to sit outside any window these tests open. */
const ANCIENT = '2000-01-01T00:00:00.000Z'

// ── helpers ──────────────────────────────────────────────────────────────────

/** Save/restore `config.placement` across a callback (same recipe as the apply suite). */
function withPlacementConfig(overrides: Partial<typeof config.placement>, fn: () => void): void {
  const saved = config.placement
  config.placement = { ...saved, ...overrides }
  try {
    fn()
  } finally {
    config.placement = saved
  }
}

/** The first IN-window `decided_at`: the cutoff comparison is inclusive (spec D5). */
function cutoffFor(now: string, ttlDays = config.placement.proposalTtlDays): string {
  return new Date(Date.parse(now) - ttlDays * DAY_MS).toISOString()
}

/** One millisecond past the cutoff — strictly older, therefore out of window. */
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
  const { changes } = db.prepare('UPDATE placement_proposals SET decided_at = ? WHERE id = ?').run(decidedAt, id)
  if (changes === 0) throw new Error(`proposal '${id}' not found`)
}

function rowOf(db: Database, id: string): { state: string; decided_at: string | null } {
  const row = db.prepare('SELECT state, decided_at FROM placement_proposals WHERE id = ?').get(id) as
    | { state: string; decided_at: string | null }
    | undefined
  if (!row) throw new Error(`proposal '${id}' not found`)
  return row
}

/** The report item for one row, by id — manifest order is covered in the apply suite. */
function itemFor(report: RollbackReport, proposalId: string): RollbackItemReport {
  const item = report.items.find(i => i.proposal_id === proposalId)
  if (!item) throw new Error(`no report item for '${proposalId}': ${report.items.map(i => i.proposal_id).join(', ')}`)
  return item
}

/** Everything rollback could reach, so a refusal can be proven to mutate nothing. */
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

/**
 * Enqueue an `edge` row whose fingerprint matches the live (active) pair, then
 * accept it — the one revertible mutation the queue can still perform.
 */
function acceptedEdgeRow(db: Database, id: string): AcceptedEdge {
  const source = seedThought({ id: `${id}-s`, content: `${id} source content`, status: 'active', created_at: NOW })
  const target = seedThought({ id: `${id}-t`, content: `${id} target content`, status: 'active', created_at: PAST })
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
  const out = applyProposalService(row.id, { confirm: true, now: NOW, runId: RUN_ID, decidedBy: 'tester' }, db)
  expect(out.status).toBe('accepted')
  assertAccepted(db, row.id)
  return { rowId: row.id, source, target }
}

/** Does the accepted edge still exist in the graph? */
function edgeHeld(db: Database, pair: AcceptedEdge): boolean {
  return getEdgePairBetween(db, pair.source, pair.target) !== null
}

// ── AC-F14-1: an out-of-window row is refused, nothing is reverted ────────────

describe('F-14 AC-1: rollback window refusal', () => {
  test('an accepted edge row decided outside the window is refused and not reverted', () => {
    const db = getDb()
    const pair = acceptedEdgeRow(db, 'f14-1')
    expect(edgeHeld(db, pair)).toBe(true)
    setDecidedAt(db, pair.rowId, ANCIENT)

    const report = rollbackService(RUN_ID, { confirm: true, now: NOW_LATER }, db)

    expect(itemFor(report, pair.rowId).action).toBe('refused')
    expect(report.summary).toEqual({ reverted: 0, skipped: 0, refused: 1 })
    // graph: the inverse writer never ran, the edge is still there
    expect(edgeHeld(db, pair)).toBe(true)
    // row: still the live manifest entry, `decided_at` not rewritten
    expect(rowOf(db, pair.rowId).state).toBe('accepted')
    expect(rowOf(db, pair.rowId).decided_at).toBe(ANCIENT)
  })
})

// ── AC-F14-2: the verdict is per row, not per run ────────────────────────────

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
    // in-window row: reverted end to end
    expect(edgeHeld(db, fresh)).toBe(false)
    assertRolledBack(db, fresh.rowId)
    // out-of-window row: untouched graph state and untouched row
    expect(edgeHeld(db, stale)).toBe(true)
    assertAccepted(db, stale.rowId)
  })
})

// ── AC-F14-3: dry-run reports the refusal and mutates nothing ─────────────────

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
    // a dry run never claims a revert it will not perform
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

// ── AC-F14-4: the boundary is inclusive ──────────────────────────────────────

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
    // The two cases above are only meaningful against a known window width.
    expect(config.placement.proposalTtlDays).toBe(DEFAULT_TTL_DAYS)
    expect(cutoffFor(NOW)).toBe(new Date(Date.parse(NOW) - DEFAULT_TTL_DAYS * DAY_MS).toISOString())
  })
})

// ── AC-F14-5: fail-closed on an unmeasurable row ─────────────────────────────

describe('F-14 AC-5: unmeasurable decided_at', () => {
  const FAIL_CLOSED_REASON = 'accepted row has no decided_at; cannot verify the rollback window'

  test('an accepted row with decided_at === null is refused, not reverted', () => {
    const db = getDb()
    const pair = acceptedEdgeRow(db, 'f14-5-null')
    // legacy pre-fix data: accepted, enveloped, but never stamped
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
    // `now` is a test seam, not a public surface: RollbackOptions calls it a
    // deterministic clock override (placement-apply.types.ts:118) and neither
    // POST /proposals/rollback nor memory_review forwards one, so this suite is
    // the only way in — and windowRefusal must still refuse a malformed clock
    // (placement-rollback.service.ts:56) rather than raise a RangeError/500.
    const db = getDb()
    const pair = acceptedEdgeRow(db, 'f14-5-now')

    const report = rollbackService(RUN_ID, { confirm: true, now: 'not-a-clock' }, db)

    expect(itemFor(report, pair.rowId).action).toBe('refused')
    expect(itemFor(report, pair.rowId).reason).toContain('cannot verify the rollback window')
    expect(edgeHeld(db, pair)).toBe(true)
    assertAccepted(db, pair.rowId)
  })
})

// ── AC-F14-6: a negative TTL disables the guard ──────────────────────────────

describe('F-14 AC-6: proposalTtlDays < 0 disables the guard', () => {
  test('the same row refused at the default TTL reverts once retention is disabled', () => {
    const db = getDb()
    const pair = acceptedEdgeRow(db, 'f14-6')
    setDecidedAt(db, pair.rowId, ANCIENT)

    // Control: at the default TTL this row is out of window.
    const guarded = rollbackService(RUN_ID, { confirm: true, now: NOW_LATER }, db)
    expect(guarded.items[0].action).toBe('refused')
    expect(edgeHeld(db, pair)).toBe(true)

    // With pruning disabled nothing is ever out of window, so nothing is refused.
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

// ── guard order: window outranks the other verdicts (spec D5) ─────────────────

describe('F-14 guard order', () => {
  test('a row that is both out-of-window and fingerprint-drifted is refused for the window', () => {
    const db = getDb()
    const pair = acceptedEdgeRow(db, 'f14-order')
    setDecidedAt(db, pair.rowId, ANCIENT)
    // drift the fingerprint as well
    db.prepare("UPDATE thoughts SET updated_at = '2099-01-01T00:00:00.000Z' WHERE id = ?").run(pair.source)

    const report = rollbackService(RUN_ID, { confirm: true, now: NOW_LATER }, db)

    expect(itemFor(report, pair.rowId).action).toBe('refused')
    expect(itemFor(report, pair.rowId).reason).toContain('rollback window')
    expect(itemFor(report, pair.rowId).reason).not.toContain('fingerprint')
    expect(edgeHeld(db, pair)).toBe(true)
    assertAccepted(db, pair.rowId)
  })
})

// ── AC-F14-8: the window changes nothing for in-window rows ──────────────────

describe('F-14 AC-8: in-window behaviour is unchanged', () => {
  test('every reversible row still reverts while in-window', () => {
    const db = getDb()
    const first = acceptedEdgeRow(db, 'f14-8-edge')
    const second = acceptedEdgeRow(db, 'f14-8-edge2')
    const rows = [first.rowId, second.rowId]

    // post-apply graph: the run linked both pairs
    expect(edgeHeld(db, first)).toBe(true)
    expect(edgeHeld(db, second)).toBe(true)
    const edgesAfterApply = graphCounts(db).edges

    const report = rollbackService(RUN_ID, { confirm: true, now: NOW_LATER }, db)

    expect(report.summary).toEqual({ reverted: 2, skipped: 0, refused: 0 })
    for (const id of rows) expect(itemFor(report, id).action).toBe('reverted')
    // graph inverses: only the edges this run created are gone, nothing else
    expect(graphCounts(db).edges).toBe(edgesAfterApply - 2)
    for (const id of rows) assertRolledBack(db, id)
  })

  test('a removed-kind row is refused with a typed reason, and the window does not shadow it', () => {
    const db = getDb()
    const source = seedThought({ id: 'f14-8-merge-s', content: 'matrix merge src', status: 'active', created_at: NOW })
    const target = seedThought({ id: 'f14-8-merge-t', content: 'matrix merge tgt', status: 'active', created_at: PAST })
    // In-window on purpose: the refusal must come from the removed-kind guard, not the window.
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
    // graph untouched
    expect(getThoughtRow(db, source)!.status).toBe('active')
    expect(getThoughtRow(db, target)!.status).toBe('active')
    expect(graphCounts(db).edges).toBe(edgesBefore)
    assertAccepted(db, mergeRowId)
  })
})
