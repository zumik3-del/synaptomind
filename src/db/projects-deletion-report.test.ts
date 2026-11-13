import { afterEach, beforeEach, expect, test } from 'bun:test'
import { getDb } from '../context/container'
import { createTestDb, seedThought } from '../test/helpers'
import { closeDb } from './init'
import { createProject, deleteProject, resolveDefaultProjectId } from './projects'
import { getThought } from './thoughts'

beforeEach(createTestDb)
afterEach(closeDb)

const OLDER = '2026-01-01T00:00:00.000Z'
const NEWER = '2026-01-02T00:00:00.000Z'

function liveIds(content: string, projectId: string): string[] {
  return (
    getDb()
      .prepare(
        `SELECT id FROM thoughts
         WHERE content = ? AND project_id = ? AND status IN ('draft', 'active')
         ORDER BY created_at ASC, id ASC`
      )
      .all(content, projectId) as Array<{ id: string }>
  ).map(row => row.id)
}

test('a deletion that archives a collision reports the archived id and the moved count', () => {
  const db = getDb()
  const defaultId = resolveDefaultProjectId(db)
  const project = createProject(db, { name: 'Doomed' })
  const content = 'shared body'
  const settledId = seedThought({ content, project_id: defaultId, created_at: OLDER })
  const movedId = seedThought({ content, project_id: project.id, created_at: NEWER })
  seedThought({ content: 'unique body', project_id: project.id, created_at: NEWER })

  const deletion = deleteProject(db, project.id)

  expect(deletion.archivedIds).toEqual([movedId])
  expect(deletion.moved).toBe(2)

  const archived = getThought(db, movedId)
  expect(archived?.status).toBe('archived')
  expect(archived?.project_id).toBe(defaultId)
  expect(archived?.archived_at).not.toBeNull()
  expect(liveIds(content, defaultId)).toEqual([settledId])
})

test('an archived loser keeps the is_protected value it had before the deletion', () => {
  const db = getDb()
  const defaultId = resolveDefaultProjectId(db)
  const project = createProject(db, { name: 'Doomed' })
  const protectedId = seedThought({
    content: 'protected body',
    project_id: project.id,
    created_at: NEWER
  })
  seedThought({ content: 'protected body', project_id: defaultId, created_at: OLDER })
  const unprotectedId = seedThought({
    content: 'unprotected body',
    project_id: project.id,
    created_at: NEWER,
    is_protected: 0
  })
  seedThought({ content: 'unprotected body', project_id: defaultId, created_at: OLDER })

  deleteProject(db, project.id)

  const archivedProtected = getThought(db, protectedId)
  expect(archivedProtected?.status).toBe('archived')
  expect(archivedProtected?.is_protected).toBe(1)

  const archivedUnprotected = getThought(db, unprotectedId)
  expect(archivedUnprotected?.status).toBe('archived')
  expect(archivedUnprotected?.is_protected).toBe(0)
})

test('a deletion without a collision reports no archived row', () => {
  const db = getDb()
  const defaultId = resolveDefaultProjectId(db)
  const project = createProject(db, { name: 'Doomed' })
  seedThought({ content: 'first body', project_id: project.id, created_at: NEWER })
  seedThought({ content: 'second body', project_id: project.id, created_at: NEWER })
  const settledId = seedThought({
    content: 'untouched body',
    project_id: defaultId,
    created_at: OLDER
  })

  const deletion = deleteProject(db, project.id)

  expect(deletion.archivedIds).toEqual([])
  expect(deletion.moved).toBe(2)
  expect(getThought(db, settledId)?.status).toBe('active')
})
