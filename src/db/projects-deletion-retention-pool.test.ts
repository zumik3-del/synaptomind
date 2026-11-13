import { afterEach, beforeEach, expect, test } from 'bun:test'
import { getDb } from '../context/container'
import { createTestDb, seedThought } from '../test/helpers'
import { closeDb } from './init'
import { createProject, deleteProject, resolveDefaultProjectId } from './projects'
import {
  countIncomingActiveRetentionReviewEdges,
  getRetentionReviewEligibilityThought,
  listRetentionReviewCandidates
} from './retention-review'

beforeEach(createTestDb)
afterEach(closeDb)

const OLDER = '2026-01-01T00:00:00.000Z'
const NEWER = '2026-01-02T00:00:00.000Z'
// Past any archived_at a deletion can write, so age never decides the exclusion.
const AFTER_DELETION = '2030-01-01T00:00:00.000Z'
const POOL = {
  cutoff: AFTER_DELETION,
  importanceFloor: 1,
  now: AFTER_DELETION,
  limit: 100,
  offset: 0
}

// v016's trigger seeds importance at 1.0, so the sub-floor value has to be written back.
function lowImportance(id: string): string {
  getDb().prepare('UPDATE thought_importance SET importance = 0.1 WHERE thought_id = ?').run(id)
  return id
}

function poolIds(): string[] {
  return listRetentionReviewCandidates(getDb(), POOL).map(row => row.id)
}

test('a protected loser archived by a deletion is not in the retention-review pool, an unprotected draft is', () => {
  const db = getDb()
  const defaultId = resolveDefaultProjectId(db)
  const project = createProject(db, { name: 'Doomed' })
  const content = 'colliding body'
  seedThought({ content, project_id: defaultId, created_at: OLDER })
  const loserId = lowImportance(
    seedThought({ content, project_id: project.id, created_at: NEWER, is_protected: 1 })
  )
  const draftId = lowImportance(
    seedThought({
      content: 'draft body',
      status: 'draft',
      project_id: defaultId,
      created_at: OLDER,
      is_protected: 0
    })
  )

  const deletion = deleteProject(db, project.id)
  const candidates = poolIds()

  expect(candidates).toContain(draftId)
  expect(candidates).not.toContain(loserId)
  expect(deletion.archivedIds).toContain(loserId)
})

test('the protected and the unprotected loser of one deletion differ only in protection', () => {
  const db = getDb()
  const defaultId = resolveDefaultProjectId(db)
  const project = createProject(db, { name: 'Doomed' })
  const loserFor = (content: string, is_protected: number): string => {
    seedThought({ content, project_id: defaultId, created_at: OLDER })
    return lowImportance(
      seedThought({ content, project_id: project.id, created_at: NEWER, is_protected })
    )
  }
  const protectedLoserId = loserFor('protected body', 1)
  const unprotectedLoserId = loserFor('unprotected body', 0)

  const deletion = deleteProject(db, project.id)
  const candidates = poolIds()

  expect(candidates).toContain(unprotectedLoserId)
  expect(candidates).not.toContain(protectedLoserId)
  expect(deletion.archivedIds).toEqual(
    expect.arrayContaining([protectedLoserId, unprotectedLoserId])
  )

  const archived = getRetentionReviewEligibilityThought(db, protectedLoserId)
  expect(archived?.status).toBe('archived')
  expect(archived?.is_protected).toBe(1)
  expect(archived?.importance).toBe(0.1)
  expect(archived?.hit_count).toBe(0)
  expect(archived?.is_global).toBe(0)
  expect(archived?.surface_after).toBeNull()
  const archivedAt = archived?.archived_at ?? ''
  expect(archivedAt).not.toBe('')
  expect(archivedAt < AFTER_DELETION).toBe(true)
  expect(countIncomingActiveRetentionReviewEdges(db, protectedLoserId)).toBe(0)
})
