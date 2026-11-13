import { afterEach, beforeEach, expect, test } from 'bun:test'
import { getDb } from '../context/container'
import { closeDb } from '../db/init'
import {
  getThoughtByIdService,
  archiveThoughtByIdService,
  archiveThoughtsBatchService
} from './thoughts.service'
import { mergeThoughtsService } from './merge.service'
import { validateMergePreconditions } from './merge-helpers.service'
import { getThoughtRow } from '../db/thoughts'
import { createTestDb, seedEdge, seedThought } from '../test/helpers'
import { listRetentionReviewCandidatesService } from './retention-review.service'
import { protectRetentionReviewCandidateService } from './retention-review-actions.service'

const now = '2026-10-23T00:00:00.000Z'
const old = '2026-09-01T00:00:00.000Z'

beforeEach(createTestDb)
afterEach(closeDb)

function leaveLegacyFlag(id: string): string {
  getDb().prepare('UPDATE thoughts SET is_profile = 1 WHERE id = ?').run(id)
  return id
}

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
  // @ts-expect-error - is_profile is retired and must not return to the type
  expect(thought.is_profile).toBeUndefined()
})

test('a legacy-flagged thought archives through the single-item service', () => {
  const id = leaveLegacyFlag(seedThought({ content: 'legacy persona', status: 'active' }))

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

  expect(rawFlag(id)).toBe(1)
  expect(() => validateMergePreconditions(source)).not.toThrow()
})

test('merging a legacy-flagged source archives it like any other source', () => {
  const source = leaveLegacyFlag(seedThought({ content: 'legacy persona', status: 'active' }))
  const target = seedThought({ content: 'target thought', status: 'active' })
  const neighbor = seedThought({ content: 'neighbor', status: 'active' })
  seedEdge(source, neighbor, 'develops')

  const result = mergeThoughtsService({
    sourceId: source,
    targetId: target,
    mergedContent: 'merged content'
  })

  expect(result.target.content).toBe('merged content')
  expect(getThoughtByIdService(source)?.status).toBe('archived')
  expect(getThoughtByIdService(target)?.status).toBe('active')
})

test('a legacy-flagged archived thought is a retention-review candidate and stays protectable', () => {
  const id = leaveLegacyFlag(
    seedThought({
      content: 'legacy persona',
      status: 'archived',
      is_protected: 0,
      importance: 0.1,
      created_at: old
    })
  )
  getDb().prepare('UPDATE thought_importance SET importance = 0.1 WHERE thought_id = ?').run(id)
  getDb().prepare('UPDATE thoughts SET archived_at = ? WHERE id = ?').run(old, id)
  const options = { now, minAgeDays: 30, importanceFloor: 1 }

  const listed = listRetentionReviewCandidatesService(options, getDb())
  expect(listed.candidates.map(row => row.id)).toEqual([id])
  expect(listed.total).toBe(1)

  protectRetentionReviewCandidateService(id, options, getDb())
  expect(getDb().prepare('SELECT is_protected FROM thoughts WHERE id = ?').get(id)).toEqual({
    is_protected: 1
  })
})
