/**
 * F-14 rollback-window guard — coverage for the #1047 implementation (task #1049).
 *
 * `rollback` refuses an accepted row whose `decided_at` predates the rollback
 * window `now - placement.proposalTtlDays * 86_400_000` — the same TTL that
 * prunes the queue, so the guard is the read-time backstop for a not-yet-run or
 * slow retention job (ADR 2026-09-29 §2.8, OQ-3). The window IS the retention
 * window, a negative TTL disables both, the verdict is per row, and a refusal is
 * terminal and outranks merge / idempotent / fingerprint (spec D2-D5).
 *
 * Every case injects `now`. The window is compared against that clock and never
 * against the wall clock, so no test here can flake as the calendar moves.
 */
import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import type { Database } from 'bun:sqlite'
import { config } from '../config'
import { closeDb, getDb } from '../db'
import { getEdgePairBetween } from '../db/edges'
import { insertProposal } from '../db/placement-proposals'
import { getThoughtRow } from '../db/thoughts'
import { createTestDb, seedThought } from '../test/helpers'
import { applyProposal } from './placement-apply.service'
import { rollback } from './placement-rollback.service'
import type { RollbackItemReport, RollbackReport } from './placement-apply.types'
import {
  assertAccepted,
  assertRolledBack,
  insertPendingTriage,
  NOW,
  NOW_LATER,
  PAST,
  pairFingerprint,
  RUN_ID,
} from './triage-apply-helpers'

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

/** The report item for one row, by id — manifest order is covered in the triage suite. */
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

/** Apply a triage row at `NOW` under `RUN_ID`; returns the accepted row id. */
function acceptedTriageRow(
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

type GraphRowInput = {
  item_kind: 'edge' | 'placement' | 'lifecycle'
  sourceId: string
  targetId: string
  edgeType: string
  direction: 'symmetric' | 'directed' | null
  lifecycleAction?: string
}

/** Enqueue a graph-mutating row whose fingerprint matches the live pair, then accept it. */
function acceptedGraphRow(db: Database, input: GraphRowInput): string {
  const row = insertProposal(db, {
    project_id: 'default',
    source_thought_id: input.sourceId,
    item_kind: input.item_kind,
    target_id: input.targetId,
    edge_type: input.edgeType,
    lifecycle_action: input.lifecycleAction ?? null,
    direction: input.direction,
    confidence: 0.8,
    rationale: 'F-14 regression matrix',
    payload: '{}',
    fingerprint: pairFingerprint(db, input.sourceId, input.targetId)
  })
  const out = applyProposal(row.id, { confirm: true, now: NOW, runId: RUN_ID, decidedBy: 'tester' }, db)
  expect(out.status).toBe('accepted')
  assertAccepted(db, row.id)
  return row.id
}

// ── AC-F14-1: an out-of-window row is refused, nothing is reverted ────────────

describe('F-14 AC-1: rollback window refusal', () => {
  test('an accepted activate row decided outside the window is refused and not reverted', () => {
    const db = getDb()
    const source = seedThought({ id: 'f14-1-s', content: 'out of window activate src', status: 'draft', created_at: NOW })
    const rowId = acceptedTriageRow(db, 'triage_activate', source)
    expect(getThoughtRow(db, source)!.status).toBe('active')
    setDecidedAt(db, rowId, ANCIENT)

    const report = rollback(RUN_ID, { confirm: true, now: NOW_LATER }, db)

    expect(itemFor(report, rowId).action).toBe('refused')
    expect(report.summary).toEqual({ reverted: 0, skipped: 0, refused: 1 })
    // graph: the inverse writer never ran, the source is still activated
    expect(getThoughtRow(db, source)!.status).toBe('active')
    // row: still the live manifest entry, `decided_at` not rewritten
    expect(rowOf(db, rowId).state).toBe('accepted')
    expect(rowOf(db, rowId).decided_at).toBe(ANCIENT)
  })
})

// ── AC-F14-2: the verdict is per row, not per run ────────────────────────────

describe('F-14 AC-2: a mixed-window run', () => {
  test('the in-window row reverts and the out-of-window row is refused in the same run', () => {
    const db = getDb()
    const fresh = seedThought({ id: 'f14-2-fresh', content: 'in window src', status: 'draft', created_at: NOW })
    const target = seedThought({ id: 'f14-2-t', content: 'in window archive tgt', status: 'active', created_at: PAST })
    const stale = seedThought({ id: 'f14-2-stale', content: 'out of window archive src', status: 'draft', created_at: NOW })
    const freshRow = acceptedTriageRow(db, 'triage_activate', fresh)
    const staleRow = acceptedTriageRow(db, 'triage_archive', stale, target)
    setDecidedAt(db, staleRow, ANCIENT)

    const report = rollback(RUN_ID, { confirm: true, now: NOW_LATER }, db)

    expect(report.summary).toEqual({ reverted: 1, skipped: 0, refused: 1 })
    expect(itemFor(report, freshRow).action).toBe('reverted')
    expect(itemFor(report, staleRow).action).toBe('refused')
    // in-window row: reverted end to end
    expect(getThoughtRow(db, fresh)!.status).toBe('draft')
    assertRolledBack(db, freshRow)
    // out-of-window row: untouched graph state and untouched row
    expect(getThoughtRow(db, stale)!.status).toBe('archived')
    assertAccepted(db, staleRow)
  })
})

// ── AC-F14-3: dry-run reports the refusal and mutates nothing ─────────────────

describe('F-14 AC-3: dry-run of an out-of-window row', () => {
  test('the reason names the window and the cutoff, and no state changes', () => {
    const db = getDb()
    const source = seedThought({ id: 'f14-3-s', content: 'dry run window src', status: 'draft', created_at: NOW })
    const rowId = acceptedTriageRow(db, 'triage_activate', source)
    setDecidedAt(db, rowId, ANCIENT)
    const before = graphCounts(db)

    const report = rollback(RUN_ID, { confirm: false, now: NOW_LATER }, db)

    expect(report.confirm).toBe(false)
    expect(itemFor(report, rowId).action).toBe('refused')
    expect(itemFor(report, rowId).reason).toContain('rollback window')
    expect(itemFor(report, rowId).reason).toContain(cutoffFor(NOW_LATER))
    // a dry run never claims a revert it will not perform
    expect(report.summary).toEqual({ reverted: 0, skipped: 0, refused: 1 })
    expect(graphCounts(db)).toEqual(before)
    expect(getThoughtRow(db, source)!.status).toBe('active')
    assertAccepted(db, rowId)
  })

  test('an all-out-of-window run reports reverted:0 and refuses every row', () => {
    const db = getDb()
    const first = seedThought({ id: 'f14-3-all-a', content: 'all out one', status: 'draft', created_at: NOW })
    const second = seedThought({ id: 'f14-3-all-b', content: 'all out two', status: 'draft', created_at: NOW })
    const firstRow = acceptedTriageRow(db, 'triage_activate', first)
    const secondRow = acceptedTriageRow(db, 'triage_activate', second)
    setDecidedAt(db, firstRow, ANCIENT)
    setDecidedAt(db, secondRow, ANCIENT)

    const report = rollback(RUN_ID, { confirm: false, now: NOW_LATER }, db)

    expect(report.summary).toEqual({ reverted: 0, skipped: 0, refused: 2 })
    expect(report.items.every(i => i.action === 'refused')).toBe(true)
    expect(getThoughtRow(db, first)!.status).toBe('active')
    expect(getThoughtRow(db, second)!.status).toBe('active')
  })
})

// ── AC-F14-4: the boundary is inclusive ──────────────────────────────────────

describe('F-14 AC-4: window boundary', () => {
  test('decided_at exactly at now - ttlDays*86400000 is in-window and reverts', () => {
    const db = getDb()
    const source = seedThought({ id: 'f14-4-at-s', content: 'at cutoff src', status: 'draft', created_at: NOW })
    const rowId = acceptedTriageRow(db, 'triage_activate', source)
    setDecidedAt(db, rowId, cutoffFor(NOW))

    const report = rollback(RUN_ID, { confirm: true, now: NOW }, db)

    expect(itemFor(report, rowId).action).toBe('reverted')
    expect(report.summary).toEqual({ reverted: 1, skipped: 0, refused: 0 })
    expect(getThoughtRow(db, source)!.status).toBe('draft')
    assertRolledBack(db, rowId)
  })

  test('decided_at one millisecond before the cutoff is refused', () => {
    const db = getDb()
    const source = seedThought({ id: 'f14-4-before-s', content: 'before cutoff src', status: 'draft', created_at: NOW })
    const rowId = acceptedTriageRow(db, 'triage_activate', source)
    setDecidedAt(db, rowId, beforeCutoffFor(NOW))

    const report = rollback(RUN_ID, { confirm: true, now: NOW }, db)

    expect(itemFor(report, rowId).action).toBe('refused')
    expect(report.summary).toEqual({ reverted: 0, skipped: 0, refused: 1 })
    expect(getThoughtRow(db, source)!.status).toBe('active')
    assertAccepted(db, rowId)
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
    const source = seedThought({ id: 'f14-5-null-s', content: 'null decided src', status: 'draft', created_at: NOW })
    const rowId = acceptedTriageRow(db, 'triage_activate', source)
    // legacy pre-fix data: accepted, enveloped, but never stamped
    setDecidedAt(db, rowId, null)

    const report = rollback(RUN_ID, { confirm: true, now: NOW_LATER }, db)

    expect(itemFor(report, rowId).action).toBe('refused')
    expect(itemFor(report, rowId).reason).toBe(FAIL_CLOSED_REASON)
    expect(report.summary).toEqual({ reverted: 0, skipped: 0, refused: 1 })
    expect(getThoughtRow(db, source)!.status).toBe('active')
    expect(rowOf(db, rowId).state).toBe('accepted')
    expect(rowOf(db, rowId).decided_at).toBeNull()
  })

  test('an accepted row with an unparseable decided_at is refused, not reverted', () => {
    const db = getDb()
    const source = seedThought({ id: 'f14-5-bad-s', content: 'bad decided src', status: 'draft', created_at: NOW })
    const rowId = acceptedTriageRow(db, 'triage_activate', source)
    setDecidedAt(db, rowId, 'not-a-timestamp')

    const report = rollback(RUN_ID, { confirm: true, now: NOW_LATER }, db)

    expect(itemFor(report, rowId).action).toBe('refused')
    expect(itemFor(report, rowId).reason).toBe(FAIL_CLOSED_REASON)
    expect(report.summary).toEqual({ reverted: 0, skipped: 0, refused: 1 })
    expect(getThoughtRow(db, source)!.status).toBe('active')
    assertAccepted(db, rowId)
  })

  test('an unparseable rollback clock fails closed instead of throwing', () => {
    // `now` is a test seam, not a public surface: RollbackOptions calls it a
    // deterministic clock override (placement-apply.types.ts:118) and neither
    // POST /proposals/rollback nor memory_review forwards one, so this suite is
    // the only way in — and windowRefusal must still refuse a malformed clock
    // (placement-rollback.service.ts:56) rather than raise a RangeError/500.
    const db = getDb()
    const source = seedThought({ id: 'f14-5-now-s', content: 'bad clock src', status: 'draft', created_at: NOW })
    const rowId = acceptedTriageRow(db, 'triage_activate', source)

    const report = rollback(RUN_ID, { confirm: true, now: 'not-a-clock' }, db)

    expect(itemFor(report, rowId).action).toBe('refused')
    expect(itemFor(report, rowId).reason).toContain('cannot verify the rollback window')
    expect(getThoughtRow(db, source)!.status).toBe('active')
    assertAccepted(db, rowId)
  })
})

// ── AC-F14-6: a negative TTL disables the guard ──────────────────────────────

describe('F-14 AC-6: proposalTtlDays < 0 disables the guard', () => {
  test('the same row refused at the default TTL reverts once retention is disabled', () => {
    const db = getDb()
    const source = seedThought({ id: 'f14-6-s', content: 'ttl disabled src', status: 'draft', created_at: NOW })
    const rowId = acceptedTriageRow(db, 'triage_activate', source)
    setDecidedAt(db, rowId, ANCIENT)

    // Control: at the default TTL this row is out of window.
    const guarded = rollback(RUN_ID, { confirm: true, now: NOW_LATER }, db)
    expect(guarded.items[0].action).toBe('refused')
    expect(getThoughtRow(db, source)!.status).toBe('active')

    // With pruning disabled nothing is ever out of window, so nothing is refused.
    withPlacementConfig({ proposalTtlDays: -1 }, () => {
      const report = rollback(RUN_ID, { confirm: true, now: NOW_LATER }, db)

      expect(itemFor(report, rowId).action).toBe('reverted')
      expect(report.summary).toEqual({ reverted: 1, skipped: 0, refused: 0 })
      expect(getThoughtRow(db, source)!.status).toBe('draft')
      assertRolledBack(db, rowId)
    })
  })

  test('proposalTtlDays === 0 is the valid extreme: only decided_at >= now survives', () => {
    const db = getDb()
    const older = seedThought({ id: 'f14-6-zero-a', content: 'zero ttl older', status: 'draft', created_at: NOW })
    const exact = seedThought({ id: 'f14-6-zero-b', content: 'zero ttl exact', status: 'draft', created_at: NOW })
    const olderRow = acceptedTriageRow(db, 'triage_activate', older)
    const exactRow = acceptedTriageRow(db, 'triage_activate', exact)
    setDecidedAt(db, olderRow, beforeCutoffFor(NOW_LATER, 0))
    setDecidedAt(db, exactRow, NOW_LATER)

    withPlacementConfig({ proposalTtlDays: 0 }, () => {
      const report = rollback(RUN_ID, { confirm: true, now: NOW_LATER }, db)

      expect(itemFor(report, olderRow).action).toBe('refused')
      expect(itemFor(report, exactRow).action).toBe('reverted')
      expect(report.summary).toEqual({ reverted: 1, skipped: 0, refused: 1 })
      expect(getThoughtRow(db, older)!.status).toBe('active')
      expect(getThoughtRow(db, exact)!.status).toBe('draft')
    })
  })
})

// ── guard order: window outranks the other verdicts (spec D5) ─────────────────

describe('F-14 guard order', () => {
  test('a row that is both out-of-window and fingerprint-drifted is refused for the window', () => {
    const db = getDb()
    const source = seedThought({ id: 'f14-order-s', content: 'drifted and old src', status: 'draft', created_at: NOW })
    const rowId = acceptedTriageRow(db, 'triage_activate', source)
    setDecidedAt(db, rowId, ANCIENT)
    // drift the fingerprint as well
    db.prepare("UPDATE thoughts SET updated_at = '2099-01-01T00:00:00.000Z' WHERE id = ?").run(source)

    const report = rollback(RUN_ID, { confirm: true, now: NOW_LATER }, db)

    expect(itemFor(report, rowId).action).toBe('refused')
    expect(itemFor(report, rowId).reason).toContain('rollback window')
    expect(itemFor(report, rowId).reason).not.toContain('fingerprint')
    expect(getThoughtRow(db, source)!.status).toBe('active')
    assertAccepted(db, rowId)
  })
})

// ── AC-F14-8: the window changes nothing for in-window rows ──────────────────

describe('F-14 AC-8: in-window behaviour is unchanged', () => {
  test('every reversible kind still reverts while in-window', () => {
    const db = getDb()
    const activateSource = seedThought({ id: 'f14-8-act-s', content: 'matrix activate src', status: 'draft', created_at: NOW })
    const activateRow = acceptedTriageRow(db, 'triage_activate', activateSource)
    const archiveSource = seedThought({ id: 'f14-8-arc-s', content: 'matrix archive src', status: 'draft', created_at: NOW })
    const archiveTarget = seedThought({ id: 'f14-8-arc-t', content: 'matrix archive tgt', status: 'active', created_at: PAST })
    const archiveRow = acceptedTriageRow(db, 'triage_archive', archiveSource, archiveTarget)
    const edgeSource = seedThought({ id: 'f14-8-edge-s', content: 'matrix edge src', status: 'active', created_at: NOW })
    const edgeTarget = seedThought({ id: 'f14-8-edge-t', content: 'matrix edge tgt', status: 'active', created_at: PAST })
    const edgeRow = acceptedGraphRow(db, {
      item_kind: 'edge', sourceId: edgeSource, targetId: edgeTarget, edgeType: 'related', direction: 'symmetric'
    })
    const placeSource = seedThought({ id: 'f14-8-place-s', content: 'matrix placement src', status: 'active', created_at: NOW })
    const placeTarget = seedThought({ id: 'f14-8-place-t', content: 'matrix placement tgt', status: 'active', created_at: PAST })
    const placeRow = acceptedGraphRow(db, {
      item_kind: 'placement', sourceId: placeSource, targetId: placeTarget, edgeType: 'parent', direction: 'directed'
    })
    const lifeSource = seedThought({ id: 'f14-8-life-s', content: 'matrix supersede src', status: 'active', created_at: NOW })
    const lifeTarget = seedThought({ id: 'f14-8-life-t', content: 'matrix supersede tgt', status: 'active', created_at: PAST })
    const lifeRow = acceptedGraphRow(db, {
      item_kind: 'lifecycle', sourceId: lifeSource, targetId: lifeTarget, edgeType: 'replaces',
      direction: null, lifecycleAction: 'replaces+archive'
    })
    const rows = [activateRow, archiveRow, edgeRow, placeRow, lifeRow]

    // post-apply graph: the run activated, archived and linked
    expect(getThoughtRow(db, activateSource)!.status).toBe('active')
    expect(getThoughtRow(db, archiveSource)!.status).toBe('archived')
    expect(getThoughtRow(db, lifeTarget)!.status).toBe('archived')
    for (const [source, target] of [[edgeSource, edgeTarget], [placeSource, placeTarget], [lifeSource, lifeTarget]] as const) {
      expect(getEdgePairBetween(db, source, target)).not.toBeNull()
    }
    const edgesAfterApply = graphCounts(db).edges

    const report = rollback(RUN_ID, { confirm: true, now: NOW_LATER }, db)

    expect(report.summary).toEqual({ reverted: 5, skipped: 0, refused: 0 })
    for (const id of rows) expect(itemFor(report, id).action).toBe('reverted')
    // graph inverses: activate/archive back to draft, supersede target back to active
    expect(getThoughtRow(db, activateSource)!.status).toBe('draft')
    expect(getThoughtRow(db, archiveSource)!.status).toBe('draft')
    expect(getThoughtRow(db, lifeTarget)!.status).toBe('active')
    // only the three edges this run created are gone, nothing else
    expect(graphCounts(db).edges).toBe(edgesAfterApply - 3)
    for (const id of rows) assertRolledBack(db, id)
  })

  test('lifecycle/merge is still refused, and the window does not shadow that reason', () => {
    const db = getDb()
    const source = seedThought({ id: 'f14-8-merge-s', content: 'matrix merge src', status: 'active', created_at: NOW })
    const target = seedThought({ id: 'f14-8-merge-t', content: 'matrix merge tgt', status: 'active', created_at: PAST })
    // In-window on purpose: the refusal must come from the merge guard, not the window.
    const mergeRowId = 'row-f14-8-merge'
    db.prepare(`
      INSERT INTO placement_proposals
        (id, project_id, source_thought_id, item_kind, target_id, edge_type, lifecycle_action, direction,
         confidence, rationale, rule_id, payload, fingerprint, state, created_at, run_id, decided_at, applied_at, result)
      VALUES (?, 'default', ?, 'lifecycle', ?, null, 'merge', null,
              0.9, 'merge in-window', null, '{}', 'merge-fp', 'accepted', ?, ?, ?, ?, ?)
    `).run(mergeRowId, source, target, NOW, RUN_ID, NOW, NOW, JSON.stringify({ idempotent: false }))
    const edgesBefore = graphCounts(db).edges

    const report = rollback(RUN_ID, { confirm: true, now: NOW_LATER }, db)

    expect(report.summary).toEqual({ reverted: 0, skipped: 0, refused: 1 })
    expect(itemFor(report, mergeRowId).action).toBe('refused')
    expect(itemFor(report, mergeRowId).reason).toContain('merge')
    expect(itemFor(report, mergeRowId).reason).not.toContain('rollback window')
    // graph untouched
    expect(getThoughtRow(db, source)!.status).toBe('active')
    expect(getThoughtRow(db, target)!.status).toBe('active')
    expect(graphCounts(db).edges).toBe(edgesBefore)
    assertAccepted(db, mergeRowId)
  })
})
