/**
 * `duplicate_drafts` finding and its `isScheduledReminder` classifier
 * (task #1946; coverage restored by task #1962).
 *
 * The finder is read-only and model-free: it reuses the engine's own lexical
 * near-duplicate rule (`findMergeTarget`, Jaccard >= 0.6) over the draft's
 * project-scoped active pool. These tests pin the finding itself (shape, one
 * finding per draft), every exclusion the retired triage used to guard, and the
 * clock the reminder branch compares against.
 */
import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { getDb } from '../db'
import { closeDb } from '../db/init'
import type { Thought } from '../db/thoughts'
import type { Tag } from '../db/tags'
import { createTestDb, seedThought } from '../test/helpers'
import { findDuplicateDrafts, isScheduledReminder } from './health-check-drafts.service'

beforeEach(createTestDb)
afterEach(closeDb)

const NOW = '2026-06-01T00:00:00.000Z'
const PAST = '2026-01-01T00:00:00.000Z'
const FUTURE = '2026-12-01T00:00:00.000Z'

/** A standalone `Thought` for the pure classifier — no DB row needed. */
function thought(overrides: Partial<Thought> = {}): Thought {
  return {
    id: 'thought-1',
    content: 'some content',
    status: 'draft',
    tags: [],
    source: null,
    project_id: 'default',
    is_cluster: 0,
    is_profile: 0,
    is_protected: 1,
    is_global: 0,
    created_at: NOW,
    updated_at: NOW,
    archived_at: null,
    surface_after: null,
    ...overrides
  }
}

function tag(name: string): Tag {
  return { id: `tag-${name}`, name }
}

// ── isScheduledReminder ───────────────────────────────────────────────────────

describe('isScheduledReminder', () => {
  test('a pending-tagged thought is a scheduled reminder', () => {
    expect(isScheduledReminder(thought({ tags: [tag('pending')] }), NOW)).toBe(true)
  })

  test('the pending tag is matched case-insensitively, like the frontier query', () => {
    expect(isScheduledReminder(thought({ tags: [tag('Pending')] }), NOW)).toBe(true)
  })

  test('a future surface_after is a scheduled reminder', () => {
    expect(isScheduledReminder(thought({ surface_after: FUTURE }), NOW)).toBe(true)
  })

  test('a past surface_after no longer defers the thought', () => {
    expect(isScheduledReminder(thought({ surface_after: PAST }), NOW)).toBe(false)
  })

  test('surface_after exactly at the clock is not in the future (strict comparison)', () => {
    expect(isScheduledReminder(thought({ surface_after: NOW }), NOW)).toBe(false)
  })

  test('an untagged thought with no surface_after is not a scheduled reminder', () => {
    expect(isScheduledReminder(thought(), NOW)).toBe(false)
  })

  test('an unrelated tag is not a scheduled reminder', () => {
    expect(isScheduledReminder(thought({ tags: [tag('topic')] }), NOW)).toBe(false)
  })
})

// ── findDuplicateDrafts: the finding ──────────────────────────────────────────

describe('findDuplicateDrafts: detecting a duplicate', () => {
  test('an active thought plus a near-duplicate draft yields exactly one finding', () => {
    const db = getDb()
    const active = seedThought({ content: 'alpha beta gamma delta', status: 'active' })
    const draft = seedThought({ content: 'alpha beta gamma delta epsilon', status: 'draft' })

    const findings = findDuplicateDrafts(db, NOW)

    expect(findings).toHaveLength(1)
    expect(findings[0].draft_id).toBe(draft)
    expect(findings[0].duplicate_of).toBe(active)
    // 4 shared words over a 5-word union.
    expect(findings[0].overlap).toBeCloseTo(0.8, 10)
  })

  test('an exact normalised duplicate is reported with overlap 1', () => {
    const db = getDb()
    const active = seedThought({ content: 'Shared   Topic Content', status: 'active' })
    const draft = seedThought({ content: 'shared topic content', status: 'draft' })

    const findings = findDuplicateDrafts(db, NOW)

    expect(findings).toHaveLength(1)
    expect(findings[0]).toMatchObject({ draft_id: draft, duplicate_of: active, overlap: 1 })
  })

  test('a draft is flagged once even when several active thoughts are near-duplicates', () => {
    const db = getDb()
    const weaker = seedThought({ content: 'alpha beta gamma omega', status: 'active' }) // 3/6
    const closest = seedThought({ content: 'alpha beta gamma delta epsilon', status: 'active' }) // 5/5 exact
    const draft = seedThought({ content: 'alpha beta gamma delta epsilon', status: 'draft' })

    const findings = findDuplicateDrafts(db, NOW)

    expect(findings).toHaveLength(1)
    expect(findings[0].draft_id).toBe(draft)
    expect(findings[0].duplicate_of).toBe(closest)
    expect(findings[0].duplicate_of).not.toBe(weaker)
  })

  test('two drafts each duplicating an active thought yield one finding per draft', () => {
    const db = getDb()
    seedThought({ content: 'one shared statement about cats', status: 'active' })
    seedThought({ content: 'a different statement about dogs', status: 'active' })
    const catDraft = seedThought({ content: 'one shared statement about cats indeed', status: 'draft' })
    const dogDraft = seedThought({ content: 'a different statement about dogs indeed', status: 'draft' })

    const findings = findDuplicateDrafts(db, NOW)

    expect(findings.map(f => f.draft_id).sort()).toEqual([catDraft, dogDraft].sort())
  })
})

// ── findDuplicateDrafts: no finding ───────────────────────────────────────────

describe('findDuplicateDrafts: no finding', () => {
  test('an empty DB yields no findings', () => {
    expect(findDuplicateDrafts(getDb(), NOW)).toEqual([])
  })

  test('a draft with no near-duplicate yields no finding', () => {
    const db = getDb()
    seedThought({ content: 'completely unrelated wording here', status: 'active' })
    seedThought({ content: 'a standalone draft about gardening', status: 'draft' })

    expect(findDuplicateDrafts(db, NOW)).toEqual([])
  })

  test('a draft below the lexical threshold is not a duplicate', () => {
    const db = getDb()
    seedThought({ content: 'alpha beta zeta eta theta', status: 'active', created_at: PAST })
    seedThought({ content: 'alpha beta gamma delta epsilon', status: 'draft' })

    expect(findDuplicateDrafts(db, NOW)).toEqual([])
  })

  test('an archived near-duplicate is not a duplicate (the pool holds active thoughts only)', () => {
    const db = getDb()
    seedThought({ content: 'alpha beta gamma delta', status: 'archived' })
    seedThought({ content: 'alpha beta gamma delta epsilon', status: 'draft' })

    expect(findDuplicateDrafts(db, NOW)).toEqual([])
  })

  test('a near-duplicate in another project is not flagged (project-scoped pool)', () => {
    const db = getDb()
    seedThought({ content: 'alpha beta gamma delta', status: 'active', project_id: 'other-project' })
    seedThought({ content: 'alpha beta gamma delta epsilon', status: 'draft' })

    expect(findDuplicateDrafts(db, NOW)).toEqual([])
  })
})

// ── findDuplicateDrafts: exclusions ───────────────────────────────────────────

describe('findDuplicateDrafts: exclusions', () => {
  test('a pending-tagged draft is a scheduled reminder and is never flagged', () => {
    const db = getDb()
    seedThought({ content: 'alpha beta gamma delta', status: 'active' })
    seedThought({ content: 'alpha beta gamma delta epsilon', status: 'draft', tags: '["pending"]' })

    expect(findDuplicateDrafts(db, NOW)).toEqual([])
  })

  test('a draft with a future surface_after is never flagged', () => {
    const db = getDb()
    seedThought({ content: 'alpha beta gamma delta', status: 'active' })
    seedThought({ content: 'alpha beta gamma delta epsilon', status: 'draft', surface_after: FUTURE })

    expect(findDuplicateDrafts(db, NOW)).toEqual([])
  })

  test('a draft whose surface_after already passed is flagged again', () => {
    const db = getDb()
    const active = seedThought({ content: 'alpha beta gamma delta', status: 'active' })
    const draft = seedThought({ content: 'alpha beta gamma delta epsilon', status: 'draft', surface_after: PAST })

    const findings = findDuplicateDrafts(db, NOW)

    expect(findings).toHaveLength(1)
    expect(findings[0]).toMatchObject({ draft_id: draft, duplicate_of: active })
  })

  test('a cluster thought is never flagged', () => {
    const db = getDb()
    seedThought({ content: 'alpha beta gamma delta', status: 'active' })
    seedThought({ content: 'alpha beta gamma delta epsilon', status: 'draft', is_cluster: 1 })

    expect(findDuplicateDrafts(db, NOW)).toEqual([])
  })

  test('a profile thought is never flagged', () => {
    const db = getDb()
    seedThought({ content: 'alpha beta gamma delta', status: 'active' })
    seedThought({ content: 'alpha beta gamma delta epsilon', status: 'draft', is_profile: 1 })

    expect(findDuplicateDrafts(db, NOW)).toEqual([])
  })
})
