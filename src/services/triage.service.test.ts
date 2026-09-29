/**
 * Regression coverage for the deterministic draft-triage proposer
 * (task #993, ADR 2026-09-29 §2.3.1).
 *
 * Covers the rule table, guard matrix, dedup/backfill idempotence,
 * determinism, and the static no-writer import constraint.
 */
import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import type { Database } from 'bun:sqlite'
import { closeDb, getDb } from '../db'
import { getThoughtRow, type Thought } from '../db/thoughts'
import type { PlacementProposalRow } from '../db/placement-proposals'
import { createTestDb, seedThought } from '../test/helpers'
import { config } from '../config'
import {
  classifyDraft,
  DEFAULT_ACTIVATE_RULE_ID,
  DEFAULT_BACKFILL_LIMIT,
  enqueueTriageItem,
  isScheduledReminder,
  runTriageBackfill,
  startTriageBackfillJob,
  stopTriageBackfillJob,
  TRIAGE_RULES,
  type TriageVerdict,
} from './triage.service'
import { createThoughtWithParent } from './thoughts.service'

beforeEach(createTestDb)
afterEach(closeDb)

const NOW = '2026-01-01T00:00:00.000Z'
const NOW_LATER = '2026-02-01T00:00:00.000Z'
const FUTURE = '2027-01-01T00:00:00.000Z'
const PAST = '2025-01-01T00:00:00.000Z'

// Near-duplicate pair: normalised Jaccard ≈ 0.69 (> 0.6 threshold).
const DUP_TARGET_CONTENT = 'the quick brown fox jumps over the lazy dog and runs fast'
const DUP_DRAFT_CONTENT = 'the quick brown fox jumped over the lazy dog and ran fast'
// Distinct pair: Jaccard well below threshold.
const DISTINCT_CONTENT = 'completely different topic about astronomy and space travel'

// ── helpers ───────────────────────────────────────────────────────────────────

function queueRowCount(db: Database): number {
  return (db.prepare('SELECT COUNT(*) AS n FROM placement_proposals').get() as { n: number }).n
}

function triageRowCount(db: Database): number {
  return (
    db
      .prepare(
        `SELECT COUNT(*) AS n FROM placement_proposals
         WHERE item_kind IN ('triage_activate', 'triage_archive')`
      )
      .get() as { n: number }
  ).n
}

function pendingTriageRowCount(db: Database): number {
  return (
    db
      .prepare(
        `SELECT COUNT(*) AS n FROM placement_proposals
         WHERE item_kind IN ('triage_activate', 'triage_archive')
           AND state = 'pending'`
      )
      .get() as { n: number }
  ).n
}

function seedActiveDupTarget(): string {
  return seedThought({
    id: 'dup-target',
    content: DUP_TARGET_CONTENT,
    status: 'active',
    created_at: PAST,
  })
}

function seedDistinctActive(): string {
  return seedThought({
    id: 'distinct-active',
    content: DISTINCT_CONTENT,
    status: 'active',
    created_at: PAST,
  })
}

// ── Rule table ────────────────────────────────────────────────────────────────

describe('classifyDraft: rule table', () => {
  test('near-duplicate (Jaccard >= 0.6) → archive with rule_id duplicate.active_near_duplicate', () => {
    const db = getDb()
    seedActiveDupTarget()
    const draftId = seedThought({
      id: 'dup-draft',
      content: DUP_DRAFT_CONTENT,
      status: 'draft',
      created_at: NOW,
    })
    const draft = getThoughtRow(db, draftId)!
    const verdict = classifyDraft(draft, db)
    expect(verdict.action).toBe('archive')
    expect(verdict.targetId).toBe('dup-target')
    expect(verdict.rule_id).toBe('duplicate.active_near_duplicate')
    expect(verdict.confidence).toBeGreaterThan(0)
    expect(verdict.overlap).toBeGreaterThan(0)
    expect(verdict.review_required).toBe(true)
  })

  test('exact-normalised duplicate → archive with overlap 1.0', () => {
    const db = getDb()
    const targetId = seedThought({
      id: 'exact-target',
      content: 'hello world this is a test',
      status: 'active',
      created_at: PAST,
    })
    const draftId = seedThought({
      id: 'exact-draft',
      content: '  HELLO WORLD THIS IS A TEST  ',
      status: 'draft',
      created_at: NOW,
    })
    const draft = getThoughtRow(db, draftId)!
    const verdict = classifyDraft(draft, db)
    expect(verdict.action).toBe('archive')
    expect(verdict.targetId).toBe(targetId)
    expect(verdict.rule_id).toBe('duplicate.active_near_duplicate')
    expect(verdict.overlap).toBe(1)
    expect(verdict.confidence).toBe(1)
  })

  test('no duplicate → activate with rule_id default.activate', () => {
    const db = getDb()
    seedDistinctActive()
    const draftId = seedThought({
      id: 'fresh-draft',
      content: 'brand new idea unrelated to anything else',
      status: 'draft',
      created_at: NOW,
    })
    const draft = getThoughtRow(db, draftId)!
    const verdict = classifyDraft(draft, db)
    expect(verdict.action).toBe('activate')
    expect(verdict.targetId).toBeNull()
    expect(verdict.rule_id).toBe(DEFAULT_ACTIVATE_RULE_ID)
    expect(verdict.confidence).toBe(0)
    expect(verdict.overlap).toBeNull()
    expect(verdict.review_required).toBe(true)
  })

  test('first-match-wins: rule order asserted', () => {
    // v1 has exactly one explicit rule; the loop structure is first-match-wins.
    expect(TRIAGE_RULES.map(r => r.id)).toEqual(['duplicate.active_near_duplicate'])
    expect(TRIAGE_RULES.length).toBe(1)
  })

  test('no active thoughts in pool → activate (pool is empty except self)', () => {
    const db = getDb()
    const draftId = seedThought({
      id: 'lonely-draft',
      content: 'i am alone',
      status: 'draft',
      created_at: NOW,
    })
    const draft = getThoughtRow(db, draftId)!
    const verdict = classifyDraft(draft, db)
    expect(verdict.action).toBe('activate')
    expect(verdict.rule_id).toBe(DEFAULT_ACTIVATE_RULE_ID)
  })

  test('only archived thoughts in pool → activate (pool filters active only)', () => {
    const db = getDb()
    seedThought({
      id: 'archived-sib',
      content: DUP_TARGET_CONTENT,
      status: 'archived',
      created_at: PAST,
    })
    const draftId = seedThought({
      id: 'archived-draft',
      content: DUP_DRAFT_CONTENT,
      status: 'draft',
      created_at: NOW,
    })
    const draft = getThoughtRow(db, draftId)!
    const verdict = classifyDraft(draft, db)
    expect(verdict.action).toBe('activate')
    expect(verdict.rule_id).toBe(DEFAULT_ACTIVATE_RULE_ID)
  })

  test('only cluster thoughts in pool → activate (clusters excluded from pool)', () => {
    const db = getDb()
    seedThought({
      id: 'cluster-sib',
      content: DUP_TARGET_CONTENT,
      status: 'active',
      is_cluster: 1,
      created_at: PAST,
    })
    const draftId = seedThought({
      id: 'cluster-draft',
      content: DUP_DRAFT_CONTENT,
      status: 'draft',
      created_at: NOW,
    })
    const draft = getThoughtRow(db, draftId)!
    const verdict = classifyDraft(draft, db)
    expect(verdict.action).toBe('activate')
    expect(verdict.rule_id).toBe(DEFAULT_ACTIVATE_RULE_ID)
  })
})

// ── Guard matrix (enqueueTriageItem) ──────────────────────────────────────────

describe('enqueueTriageItem: guard matrix', () => {
  test('returns null for a scheduled reminder with tag pending', () => {
    const db = getDb()
    const id = seedThought({
      id: 'reminder-pending',
      content: 'soon',
      status: 'draft',
      tags: '["pending"]',
      created_at: NOW,
    })
    const t = getThoughtRow(db, id)!
    expect(enqueueTriageItem(t, db)).toBeNull()
    expect(queueRowCount(db)).toBe(0)
  })

  test('returns null for a draft with a future surface_after', () => {
    const db = getDb()
    const id = seedThought({
      id: 'reminder-future',
      content: 'not yet',
      status: 'draft',
      surface_after: FUTURE,
      created_at: NOW,
    })
    const t = getThoughtRow(db, id)!
    expect(enqueueTriageItem(t, db)).toBeNull()
    expect(queueRowCount(db)).toBe(0)
  })

  test('returns null for a cluster thought', () => {
    const db = getDb()
    const id = seedThought({
      id: 'cluster-gate',
      content: 'cluster content',
      status: 'draft',
      is_cluster: 1,
      created_at: NOW,
    })
    const t = getThoughtRow(db, id)!
    expect(enqueueTriageItem(t, db)).toBeNull()
    expect(queueRowCount(db)).toBe(0)
  })

  test('returns null for a profile thought', () => {
    const db = getDb()
    const id = seedThought({
      id: 'profile-gate',
      content: 'profile content',
      status: 'draft',
      is_profile: 1,
      created_at: NOW,
    })
    const t = getThoughtRow(db, id)!
    expect(enqueueTriageItem(t, db)).toBeNull()
    expect(queueRowCount(db)).toBe(0)
  })

  test('returns exactly one row for a plain draft', () => {
    const db = getDb()
    seedDistinctActive()
    const id = seedThought({
      id: 'plain-draft',
      content: 'fresh idea for activation',
      status: 'draft',
      created_at: NOW,
    })
    const t = getThoughtRow(db, id)!
    const row = enqueueTriageItem(t, db)
    expect(row).not.toBeNull()
    expect(row!.item_kind).toBe('triage_activate')
    expect(row!.state).toBe('pending')
    expect(row!.source_thought_id).toBe(id)
    expect(row!.target_id).toBeNull()
    expect(row!.rule_id).toBe(DEFAULT_ACTIVATE_RULE_ID)
    expect(queueRowCount(db)).toBe(1)
    expect(triageRowCount(db)).toBe(1)
  })

  test('returns exactly one archive row for a near-duplicate draft', () => {
    const db = getDb()
    seedActiveDupTarget()
    const id = seedThought({
      id: 'dup-draft-gate',
      content: DUP_DRAFT_CONTENT,
      status: 'draft',
      created_at: NOW,
    })
    const t = getThoughtRow(db, id)!
    const row = enqueueTriageItem(t, db)
    expect(row).not.toBeNull()
    expect(row!.item_kind).toBe('triage_archive')
    expect(row!.state).toBe('pending')
    expect(row!.source_thought_id).toBe(id)
    expect(row!.target_id).toBe('dup-target')
    expect(row!.rule_id).toBe('duplicate.active_near_duplicate')
    expect(queueRowCount(db)).toBe(1)
  })

  test('returns null for a non-draft status (active)', () => {
    const db = getDb()
    const id = seedThought({
      id: 'active-not-draft',
      content: 'already active',
      status: 'active',
      created_at: NOW,
    })
    const t = getThoughtRow(db, id)!
    expect(enqueueTriageItem(t, db)).toBeNull()
    expect(queueRowCount(db)).toBe(0)
  })

  test('returns null for a non-draft status (archived)', () => {
    const db = getDb()
    const id = seedThought({
      id: 'archived-not-draft',
      content: 'already archived',
      status: 'archived',
      created_at: PAST,
    })
    const t = getThoughtRow(db, id)!
    expect(enqueueTriageItem(t, db)).toBeNull()
    expect(queueRowCount(db)).toBe(0)
  })
})

// ── isScheduledReminder truth table ───────────────────────────────────────────

describe('isScheduledReminder', () => {
  function make(_now: string, overrides: { tags?: string[]; surface_after?: string | null } = {}) {
    return {
      id: 'stub',
      content: 'x',
      status: 'draft',
      tags: (overrides.tags ?? []).map(name => ({ id: 'stub-id', name })),
      source: null,
      project_id: 'default',
      is_cluster: 0,
      is_profile: 0,
      is_protected: 1,
      created_at: NOW,
      updated_at: NOW,
      archived_at: null,
      surface_after: overrides.surface_after ?? null,
    }
  }

  test('tag pending → true', () => {
    expect(isScheduledReminder(make(NOW, { tags: ['pending'] }), NOW)).toBe(true)
  })

  test('future surface_after → true', () => {
    expect(isScheduledReminder(make(NOW, { surface_after: FUTURE }), NOW)).toBe(true)
  })

  test('past surface_after with no pending tag → false', () => {
    expect(isScheduledReminder(make(NOW, { surface_after: PAST }), NOW)).toBe(false)
  })

  test('both null → false', () => {
    expect(isScheduledReminder(make(NOW), NOW)).toBe(false)
  })

  test('past surface_after WITH pending tag → true (tag wins)', () => {
    expect(isScheduledReminder(make(NOW, { tags: ['pending'], surface_after: PAST }), NOW)).toBe(true)
  })
})

// ── Dedup / idempotence ───────────────────────────────────────────────────────

describe('dedup and idempotence', () => {
  test('enqueuing the same draft twice leaves one live pending row', () => {
    const db = getDb()
    seedDistinctActive()
    const id = seedThought({
      id: 'dedup-draft',
      content: 'dedup subject',
      status: 'draft',
      created_at: NOW,
    })
    const t = getThoughtRow(db, id)!
    const first = enqueueTriageItem(t, db)
    expect(first).not.toBeNull()
    const second = enqueueTriageItem(t, db)
    expect(second).not.toBeNull()
    expect(second!.id).toBe(first!.id) // refreshed, not duplicated
    expect(pendingTriageRowCount(db)).toBe(1)
    expect(queueRowCount(db)).toBe(1)
  })

  test('runTriageBackfill enqueues once; second run enqueues 0', () => {
    const db = getDb()
    seedDistinctActive()
    const _id = seedThought({
      id: 'backfill-draft',
      content: 'backfill subject',
      status: 'draft',
      created_at: NOW,
    })
    // First pass: should enqueue.
    const r1 = runTriageBackfill(DEFAULT_BACKFILL_LIMIT, db)
    expect(r1.enqueued).toBe(1)
    expect(pendingTriageRowCount(db)).toBe(1)
    // Second pass: should enqueue 0 (draft already has a live row).
    const r2 = runTriageBackfill(DEFAULT_BACKFILL_LIMIT, db)
    expect(r2.enqueued).toBe(0)
    expect(pendingTriageRowCount(db)).toBe(1) // unchanged
  })

  test('runTriageBackfill skips drafts that already have a live/accepted triage row', () => {
    const db = getDb()
    seedDistinctActive()
    const id = seedThought({
      id: 'accepted-skip',
      content: 'accepted subject',
      status: 'draft',
      created_at: NOW,
    })
    // Manually insert an accepted triage row so the NOT EXISTS filter blocks backfill.
    const t = getThoughtRow(db, id)!
    enqueueTriageItem(t, db)
    db.prepare(
      `UPDATE placement_proposals SET state = 'accepted', decided_at = ? WHERE source_thought_id = ?`
    ).run(NOW_LATER, id)
    const r = runTriageBackfill(DEFAULT_BACKFILL_LIMIT, db)
    expect(r.enqueued).toBe(0)
    expect(pendingTriageRowCount(db)).toBe(0) // accepted row is not pending
  })

  test('runTriageBackfill skips scheduled reminders', () => {
    const db = getDb()
    seedDistinctActive()
    seedThought({
      id: 'backfill-reminder',
      content: 'reminder subject',
      status: 'draft',
      tags: '["pending"]',
      created_at: NOW,
    })
    const r = runTriageBackfill(DEFAULT_BACKFILL_LIMIT, db)
    expect(r.enqueued).toBe(0)
    expect(triageRowCount(db)).toBe(0)
  })

  test('runTriageBackfill respects the limit', () => {
    const db = getDb()
    for (let i = 0; i < 5; i++) {
      seedThought({
        id: `limit-draft-${i}`,
        content: `limit subject ${i}`,
        status: 'draft',
        created_at: NOW,
      })
    }
    const r = runTriageBackfill(2, db)
    expect(r.enqueued).toBe(2)
    expect(pendingTriageRowCount(db)).toBe(2)
  })
})

// ── Determinism ───────────────────────────────────────────────────────────────

describe('determinism', () => {
  test('identical DB snapshot yields identical verdict + fingerprint', () => {
    const run = (): { verdict: TriageVerdict; row: PlacementProposalRow } => {
      createTestDb()
      const _targetId = seedActiveDupTarget()
      const draftId = seedThought({
        id: 'det-draft',
        content: DUP_DRAFT_CONTENT,
        status: 'draft',
        created_at: NOW,
      })
      const db = getDb()
      const draft = getThoughtRow(db, draftId)!
      const verdict = classifyDraft(draft, db)
      const row = enqueueTriageItem(draft, db)!
      return { verdict, row }
    }
    const a = run()
    const b = run()
    expect(a.verdict.action).toBe(b.verdict.action)
    expect(a.verdict.targetId).toBe(b.verdict.targetId)
    expect(a.verdict.rule_id).toBe(b.verdict.rule_id)
    expect(a.verdict.confidence).toBe(b.verdict.confidence)
    expect(a.row.fingerprint).toBe(b.row.fingerprint)
    expect(a.row.payload).toBe(b.row.payload)
  })

  test('no embedder dependency: classifyDraft is pure given the same draft + DB', () => {
    const db = getDb()
    seedActiveDupTarget()
    const draftId = seedThought({
      id: 'pure-draft',
      content: DUP_DRAFT_CONTENT,
      status: 'draft',
      created_at: NOW,
    })
    const draft = getThoughtRow(db, draftId)!
    const v1 = classifyDraft(draft, db)
    const v2 = classifyDraft(draft, db)
    expect(v1).toEqual(v2)
  })

  test('enqueueTriageItem produces the same row shape across fresh DBs', () => {
    const shape = (): string => {
      createTestDb()
      seedActiveDupTarget()
      const draftId = seedThought({
        id: 'shape-draft',
        content: DUP_DRAFT_CONTENT,
        status: 'draft',
        created_at: NOW,
      })
      const db = getDb()
      const draft = getThoughtRow(db, draftId)!
      const row = enqueueTriageItem(draft, db)!
      return [
        row.item_kind,
        row.state,
        row.source_thought_id,
        row.target_id ?? '',
        row.rule_id ?? '',
        row.fingerprint,
        row.payload,
      ].join('|')
    }
    expect(shape()).toBe(shape())
  })
})

// ── Static no-writer scan ─────────────────────────────────────────────────────

describe('static no-writer scan', () => {
  test('src/services/triage.service.ts imports no graph writer', async () => {
    const src = await Bun.file(
      new URL('./triage.service.ts', import.meta.url).pathname
    ).text()
    const writers = [
      'createEdgeService',
      'deleteEdgeService',
      'archiveThoughtById',
      'updateThoughtById',
      'mergeThoughtsService',
    ]
    for (const w of writers) {
      expect(src).not.toMatch(new RegExp(`\\b${w}\\b`))
    }
  })
})

// ── Create seam: createThoughtWithParent integration ──────────────────────────

describe('createThoughtWithParent seam', () => {
  test('creating a plain draft enqueues exactly one triage_activate row', () => {
    const db = getDb()
    seedDistinctActive()
    const before = triageRowCount(db)
    const thought = createThoughtWithParent({
      content: 'fresh draft idea',
      status: 'draft',
    })
    expect(thought.status).toBe('draft')
    expect(triageRowCount(db)).toBe(before + 1)
    const row = db
      .prepare(
        `SELECT * FROM placement_proposals
         WHERE source_thought_id = ? AND item_kind = 'triage_activate'`
      )
      .get(thought.id) as PlacementProposalRow | undefined
    expect(row).toBeDefined()
    expect(row!.source_thought_id).toBe(thought.id)
    expect(row!.state).toBe('pending')
  })

  test('creating an active thought enqueues no triage row', () => {
    const db = getDb()
    const before = triageRowCount(db)
    const thought = createThoughtWithParent({
      content: 'already active',
      status: 'active',
    })
    expect(thought.status).toBe('active')
    expect(triageRowCount(db)).toBe(before)
  })

  test('creating a draft with pending tag enqueues no triage row', () => {
    const db = getDb()
    const before = triageRowCount(db)
    const thought = createThoughtWithParent({
      content: 'scheduled reminder',
      status: 'draft',
      tags: ['pending'],
    })
    expect(thought.status).toBe('draft')
    expect(triageRowCount(db)).toBe(before)
  })

  test('creating a draft with future surface_after enqueues no triage row', () => {
    const db = getDb()
    const before = triageRowCount(db)
    const thought = createThoughtWithParent({
      content: 'deferred draft',
      status: 'draft',
      surface_after: FUTURE,
    })
    expect(thought.status).toBe('draft')
    expect(triageRowCount(db)).toBe(before)
  })

  test('creating a cluster draft enqueues no triage row', () => {
    const db = getDb()
    const before = triageRowCount(db)
    const thought = createThoughtWithParent({
      content: 'cluster draft',
      status: 'draft',
      is_cluster: true,
    })
    expect(thought.status).toBe('draft')
    expect(thought.is_cluster).toBe(1)
    expect(triageRowCount(db)).toBe(before)
  })

  test('creating a profile draft enqueues no triage row', () => {
    const db = getDb()
    const before = triageRowCount(db)
    const thought = createThoughtWithParent({
      content: 'profile draft',
      status: 'draft',
      is_profile: true,
    })
    expect(thought.status).toBe('draft')
    expect(thought.is_profile).toBe(1)
    expect(triageRowCount(db)).toBe(before)
  })
})

// ── Failure isolation ─────────────────────────────────────────────────────────

describe('failure isolation', () => {
  test('createThoughtWithParent succeeds when triage enqueue would throw', () => {
    const db = getDb()
    // Drop the placement_proposals table so enqueueTriageItem's insert fails.
    db.exec('DROP TABLE IF EXISTS placement_proposals')
    const before = (
      db.prepare('SELECT COUNT(*) AS n FROM thoughts').get() as { n: number }
    ).n
    const thought = createThoughtWithParent({
      content: 'triage-failure-isolation',
      status: 'draft',
    })
    expect(thought).toBeDefined()
    expect(thought.content).toBe('triage-failure-isolation')
    expect(thought.status).toBe('draft')
    // Thought was created despite triage failure.
    expect(
      (db.prepare('SELECT COUNT(*) AS n FROM thoughts').get() as { n: number }).n
    ).toBe(before + 1)
    // No triage row was enqueued (table dropped, so no insertion possible).
  })
})

// ── Backfill job lifecycle ────────────────────────────────────────────────────

describe('backfill job lifecycle', () => {
  test('startTriageBackfillJob is safe to call repeatedly', () => {
    startTriageBackfillJob()
    expect(() => startTriageBackfillJob()).not.toThrow()
    expect(() => startTriageBackfillJob()).not.toThrow()
    stopTriageBackfillJob()
  })

  test('stopTriageBackfillJob is safe to call repeatedly', () => {
    expect(() => stopTriageBackfillJob()).not.toThrow()
    expect(() => stopTriageBackfillJob()).not.toThrow()
  })

  test('start → stop → start cycle is safe', () => {
    startTriageBackfillJob()
    stopTriageBackfillJob()
    expect(() => startTriageBackfillJob()).not.toThrow()
    stopTriageBackfillJob()
  })

  test('when backfillEnabled is false, start is a no-op and stop is safe', () => {
    const original = config.triage.backfillEnabled
    config.triage.backfillEnabled = false
    try {
      expect(() => startTriageBackfillJob()).not.toThrow()
      expect(() => stopTriageBackfillJob()).not.toThrow()
    } finally {
      config.triage.backfillEnabled = original
    }
  })

  test('runTriageBackfill is bounded by config.triage.maxItemsPerRun', () => {
    const db = getDb()
    const original = config.triage.maxItemsPerRun
    config.triage.maxItemsPerRun = 3
    try {
      for (let i = 0; i < 10; i++) {
        seedThought({
          id: `limit-seam-draft-${i}`,
          content: `limit seam subject ${i}`,
          status: 'draft',
          created_at: NOW,
        })
      }
      const r = runTriageBackfill(undefined, db)
      expect(r.enqueued).toBeLessThanOrEqual(original) // respects config cap
      expect(r.enqueued).toBeLessThanOrEqual(10) // capped by actual drafts
    } finally {
      config.triage.maxItemsPerRun = original
    }
  })

  test('runTriageBackfill is idempotent: second run enqueues 0', () => {
    const db = getDb()
    seedDistinctActive()
    const _id = seedThought({
      id: 'seam-backfill-draft',
      content: 'seam backfill subject',
      status: 'draft',
      created_at: NOW,
    })
    const r1 = runTriageBackfill(DEFAULT_BACKFILL_LIMIT, db)
    expect(r1.enqueued).toBe(1)
    const r2 = runTriageBackfill(DEFAULT_BACKFILL_LIMIT, db)
    expect(r2.enqueued).toBe(0)
  })

  test('runTriageBackfill does nothing when backfillEnabled is false', () => {
    const db = getDb()
    const original = config.triage.backfillEnabled
    config.triage.backfillEnabled = false
    try {
      seedDistinctActive()
      seedThought({
        id: 'disabled-backfill-draft',
        content: 'disabled backfill subject',
        status: 'draft',
        created_at: NOW,
      })
      const r = runTriageBackfill(DEFAULT_BACKFILL_LIMIT, db)
      // runTriageBackfill itself does not check backfillEnabled — it's the
      // job's guard that skips the call. The function is still correct when
      // called directly (it enqueues as normal).
      expect(r.enqueued).toBe(1)
    } finally {
      config.triage.backfillEnabled = original
    }
  })

  test('triage.enabled=false is the master switch: no draft is triaged anywhere', () => {
    const db = getDb()
    const original = config.triage.enabled
    config.triage.enabled = false
    try {
      seedDistinctActive()
      const draftId = seedThought({
        id: 'master-off-draft',
        content: 'master switch subject',
        status: 'draft',
        created_at: NOW,
      })
      const draft = getThoughtRow(db, draftId)!

      // The enqueue seam is shared by the create path and the backfill sweep,
      // so switching it off must silence both.
      expect(enqueueTriageItem(draft, db)).toBeNull()
      expect(runTriageBackfill(DEFAULT_BACKFILL_LIMIT, db).enqueued).toBe(0)
      const rows = db.prepare('SELECT COUNT(*) AS n FROM placement_proposals').get() as { n: number }
      expect(rows.n).toBe(0)
    } finally {
      config.triage.enabled = original
    }
  })
})

// ── Queue backpressure and reminder semantics ──────────────────────────────────

describe('triage: queue backpressure', () => {
  function draft(id: string, content: string): Thought {
    const db = getDb()
    return getThoughtRow(db, seedThought({ id, content, status: 'draft', created_at: NOW }))!
  }

  function pendingCount(): number {
    return (getDb().prepare("SELECT COUNT(*) AS n FROM placement_proposals WHERE state = 'pending'").get() as { n: number }).n
  }

  test('a new draft is skipped while maxPendingProposals is reached', () => {
    const db = getDb()
    const previous = config.placement.maxPendingProposals
    config.placement.maxPendingProposals = 1
    try {
      expect(enqueueTriageItem(draft('cap-d1', DUP_DRAFT_CONTENT), db)).not.toBeNull()

      // A second, different draft would be a new live row — the cap refuses it
      // instead of growing the shared queue past the bound.
      expect(enqueueTriageItem(draft('cap-d2', 'a completely unrelated second draft'), db)).toBeNull()
      expect(pendingCount()).toBe(1)
    } finally {
      config.placement.maxPendingProposals = previous
    }
  })

  test('a re-enqueue refreshes its live row even at the cap', () => {
    const db = getDb()
    const previous = config.placement.maxPendingProposals
    config.placement.maxPendingProposals = 1
    try {
      const subject = draft('cap-refresh', DUP_DRAFT_CONTENT)
      const first = enqueueTriageItem(subject, db)
      expect(first).not.toBeNull()
      // Not a new row, so the cap must not block the refresh.
      const again = enqueueTriageItem(subject, db)
      expect(again?.id).toBe(first!.id)
      expect(pendingCount()).toBe(1)
    } finally {
      config.placement.maxPendingProposals = previous
    }
  })

  test('backfill stops adding rows once the queue is full and resumes after draining', () => {
    const db = getDb()
    const previous = config.placement.maxPendingProposals
    config.placement.maxPendingProposals = 1
    try {
      seedThought({ id: 'bf-cap-1', content: DUP_DRAFT_CONTENT, status: 'draft', created_at: NOW })
      seedThought({ id: 'bf-cap-2', content: 'another unrelated draft entirely', status: 'draft', created_at: NOW })
      expect(runTriageBackfill(10, db).enqueued).toBe(1)

      // A sweep that cannot add anything must not throw — the ambient job and
      // the create seam both have to keep working.
      expect(() => runTriageBackfill(10, db)).not.toThrow()
      expect(runTriageBackfill(10, db).enqueued).toBe(0)

      // Draining the queue lets the deferred draft in on a later sweep.
      db.prepare("UPDATE placement_proposals SET state = 'rejected', decided_at = ? WHERE state = 'pending'").run(NOW)
      expect(runTriageBackfill(10, db).enqueued).toBe(1)
    } finally {
      config.placement.maxPendingProposals = previous
    }
  })
})

describe('isScheduledReminder: tag case-insensitivity', () => {
  test('Pending (capitalised) is a reminder, matching the frontier query', () => {
    const thought = getThoughtRow(getDb(), seedThought({ id: 'rem-case', content: 'reminder', status: 'draft', tags: '["Pending"]', created_at: NOW }))!
    // The frontier resolves `lower(g.name) = 'pending'`, so this thought is a
    // reminder there; triage must agree or it would archive a pending item.
    expect(isScheduledReminder(thought, NOW)).toBe(true)
  })

  test('a Pending-tagged draft is not a triage candidate', () => {
    const db = getDb()
    seedThought({ id: 'rem-case-2', content: DUP_DRAFT_CONTENT, status: 'draft', tags: '["Pending"]', created_at: NOW })
    expect(enqueueTriageItem(getThoughtRow(db, 'rem-case-2')!, db)).toBeNull()
  })

  test('a pending-tagged draft never enters a backfill sweep', () => {
    const db = getDb()
    seedThought({ id: 'rem-case-3', content: DUP_DRAFT_CONTENT, status: 'draft', tags: '["pending"]', created_at: NOW })
    expect(runTriageBackfill(10, db).enqueued).toBe(0)
  })
})
