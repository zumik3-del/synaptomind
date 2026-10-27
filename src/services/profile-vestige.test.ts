import { afterEach, beforeEach, expect, test } from 'bun:test'
import { getDb } from '../db/container'
import { closeDb } from '../db/init'
import { getThoughtByIdService, archiveThoughtByIdService, archiveThoughtsBatchService } from './thoughts.service'
import { mergeThoughtsService } from './merge.service'
import { validateMergePreconditions } from './merge'
import { getThoughtRow } from '../db/thoughts'
import { createTestDb, seedEdge, seedThought } from '../test/helpers'
import { listRetentionReviewCandidatesService } from './retention-review.service'
import { protectRetentionReviewCandidateService } from './retention-review-actions.service'

// v047 clears the profile flag but cannot drop the column (`thoughts` is the
// foreign-key parent of six tables, so DROP COLUMN would rewrite it). A database
// written by a pre-v047 binary, or one a rolling upgrade still has open, can
// therefore carry `is_profile = 1` rows that no application code can read or
// write any more. These cases pin that such a row is an ordinary row: the
// archive guard, the merge precondition and the retention-review exclusion that
// used to special-case it are gone, and nothing reintroduces them.
//
// The flag is written with raw SQL because that is the only way it can still
// appear: the type, the test helper and every write path dropped the field.

const now = '2026-10-23T00:00:00.000Z'
const old = '2026-09-01T00:00:00.000Z'

beforeEach(createTestDb)
afterEach(closeDb)

/** Leave the retired column set on a row, the way a v46 database does. */
function leaveLegacyFlag(id: string): string {
  getDb().prepare('UPDATE thoughts SET is_profile = 1 WHERE id = ?').run(id)
  return id
}

/** The raw column, read outside the typed surface (which no longer has it). */
function rawFlag(id: string): number | null {
  const row = getDb().prepare('SELECT is_profile FROM thoughts WHERE id = ?').get(id) as
    | { is_profile: number | null }
    | undefined
  return row?.is_profile ?? null
}

test('the read surface carries no is_profile field even when the column reads 1', () => {
  const id = leaveLegacyFlag(seedThought({ content: 'legacy persona', status: 'active' }))
  expect(rawFlag(id)).toBe(1)

  const thought = getThoughtByIdService(id)!
  // Compile-time pin: the field is gone from `Thought`, so touching it is a
  // type error, not merely a runtime undefined.
  // @ts-expect-error - is_profile is retired and must not return to the type
  expect(thought.is_profile).toBeUndefined()
})

test('a legacy-flagged thought archives through the single-item service', () => {
  const id = leaveLegacyFlag(seedThought({ content: 'legacy persona', status: 'active' }))

  // Used to throw "Profile thoughts cannot be archived — clear the is_profile flag first".
  const archived = archiveThoughtByIdService(id)

  expect(archived?.status).toBe('archived')
  expect(getThoughtByIdService(id)?.status).toBe('archived')
  expect(rawFlag(id)).toBe(1)
})

test('a legacy-flagged thought archives through the batch service without a failure row', () => {
  const flagged = leaveLegacyFlag(seedThought({ content: 'legacy persona', status: 'active' }))
  const plain = seedThought({ content: 'ordinary thought', status: 'active' })

  const result = archiveThoughtsBatchService([flagged, plain])

  expect(result).toMatchObject({ archived: 2, failed: 0, errors: [] })
  expect(getThoughtByIdService(flagged)?.status).toBe('archived')
  expect(getThoughtByIdService(plain)?.status).toBe('archived')
})

test('the merge precondition accepts a legacy-flagged source', () => {
  const id = leaveLegacyFlag(seedThought({ content: 'legacy persona', status: 'active' }))
  const source = getThoughtRow(getDb(), id)!

  // The raw row still holds the column: the precondition ignores it rather than
  // the fixture failing to provide it.
  expect(rawFlag(id)).toBe(1)
  expect(() => validateMergePreconditions(source)).not.toThrow()
})

test('merging a legacy-flagged source archives it like any other source', () => {
  const source = leaveLegacyFlag(seedThought({ content: 'legacy persona', status: 'active' }))
  const target = seedThought({ content: 'target thought', status: 'active' })
  const neighbor = seedThought({ content: 'neighbor', status: 'active' })
  seedEdge(source, neighbor, 'develops')

  const result = mergeThoughtsService({ sourceId: source, targetId: target, mergedContent: 'merged content' })

  expect(result.target.content).toBe('merged content')
  expect(getThoughtByIdService(source)?.status).toBe('archived')
  expect(getThoughtByIdService(target)?.status).toBe('active')
})

test('a legacy-flagged archived thought is a retention-review candidate and stays protectable', () => {
  const id = leaveLegacyFlag(
    seedThought({ content: 'legacy persona', status: 'archived', is_protected: 0, importance: 0.1, created_at: old })
  )
  getDb().prepare('UPDATE thought_importance SET importance = 0.1 WHERE thought_id = ?').run(id)
  getDb().prepare('UPDATE thoughts SET archived_at = ? WHERE id = ?').run(old, id)
  const options = { now, minAgeDays: 30, importanceFloor: 1 }

  const listed = listRetentionReviewCandidatesService(options, getDb())
  // Used to be excluded from both the page and the total.
  expect(listed.candidates.map(row => row.id)).toEqual([id])
  expect(listed.total).toBe(1)

  // Used to be refused with a "profile" reason instead of being protected.
  protectRetentionReviewCandidateService(id, options, getDb())
  expect(getDb().prepare('SELECT is_protected FROM thoughts WHERE id = ?').get(id)).toEqual({ is_protected: 1 })
})
