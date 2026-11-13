import { afterEach, beforeEach, expect, test } from 'bun:test'
import { getDb } from '../context/container'
import { createTestDb, seedThought } from '../test/helpers'
import { computeContentHash } from '../utils'
import { closeDb } from './init'
import { createProject, deleteProject, getProject, resolveDefaultProjectId } from './projects'
import { createThought } from './thoughts'

beforeEach(createTestDb)
afterEach(closeDb)

const OLDER = '2026-01-01T00:00:00.000Z'
const NEWER = '2026-01-02T00:00:00.000Z'

const THOUGHT_ROW = `SELECT id, content, status, project_id, content_hash, archived_at, is_protected
  FROM thoughts`

interface ThoughtRow {
  id: string
  content: string
  status: string
  project_id: string
  content_hash: string | null
  archived_at: string | null
  is_protected: number
}

/**
 * A row whose stored hash belongs to its own project (`seedLive`) or to a project it no longer
 * lives in (`seedWithHash` directly) — the state `deleteProject` inherits either way.
 */
function seedWithHash(
  content: string,
  projectId: string,
  createdAt: string,
  hash: string | null,
  status = 'active'
): string {
  const id = seedThought({ content, project_id: projectId, created_at: createdAt, status })
  getDb().prepare(`UPDATE thoughts SET content_hash = ? WHERE id = ?`).run(hash, id)
  return id
}

function seedLive(
  content: string,
  projectId: string,
  createdAt: string,
  status = 'active'
): string {
  return seedWithHash(content, projectId, createdAt, computeContentHash(content, projectId), status)
}

function row(id: string): ThoughtRow {
  return getDb().prepare(`${THOUGHT_ROW} WHERE id = ?`).get(id) as ThoughtRow
}

function liveRows(content: string, projectId: string): ThoughtRow[] {
  return getDb()
    .prepare(
      `${THOUGHT_ROW} WHERE content = ? AND project_id = ? AND status IN ('draft', 'active')
       ORDER BY created_at ASC, id ASC`
    )
    .all(content, projectId) as ThoughtRow[]
}

test('deleteProject rehashes every moved thought with the destination project id', () => {
  const db = getDb()
  const defaultId = resolveDefaultProjectId(db)
  const project = createProject(db, { name: 'Doomed' })
  const moved = [
    { content: 'moved active', status: 'active' },
    { content: 'moved draft', status: 'draft' },
    { content: 'moved archived', status: 'archived' }
  ].map(thought => ({
    ...thought,
    id: seedLive(thought.content, project.id, NEWER, thought.status)
  }))

  expect(deleteProject(db, project.id).deleted).toBeTrue()

  for (const thought of moved) {
    const relocated = row(thought.id)
    expect(relocated.project_id).toBe(defaultId)
    expect(relocated.content_hash).toBe(computeContentHash(thought.content, defaultId))
  }
})

test('a moved thought absorbs a later write of the same content in the Default project', () => {
  const db = getDb()
  const defaultId = resolveDefaultProjectId(db)
  const project = createProject(db, { name: 'Doomed' })
  const content = 'shared body'
  const movedId = seedLive(content, project.id, OLDER)

  expect(deleteProject(db, project.id).deleted).toBeTrue()

  expect(createThought(db, { content, project_id: defaultId }).id).toBe(movedId)
  expect(liveRows(content, defaultId).map(thought => thought.id)).toEqual([movedId])
})

test('a moved thought that duplicates an older Default thought is archived', () => {
  const db = getDb()
  const defaultId = resolveDefaultProjectId(db)
  const project = createProject(db, { name: 'Doomed' })
  const content = 'shared body'
  const settledId = seedLive(content, defaultId, OLDER)
  const movedId = seedLive(content, project.id, NEWER)

  expect(deleteProject(db, project.id).deleted).toBeTrue()

  expect(liveRows(content, defaultId).map(thought => thought.id)).toEqual([settledId])
  const archived = row(movedId)
  expect(archived.project_id).toBe(defaultId)
  expect(archived.status).toBe('archived')
  expect(archived.archived_at).not.toBeNull()
  expect(archived.is_protected).toBe(1)
  expect(archived.content_hash).toBe(computeContentHash(content, defaultId))
})

test('a moved thought older than the Default duplicate keeps the live slot', () => {
  const db = getDb()
  const defaultId = resolveDefaultProjectId(db)
  const project = createProject(db, { name: 'Doomed' })
  const content = 'shared body'
  const movedId = seedLive(content, project.id, OLDER)
  const settledId = seedLive(content, defaultId, NEWER)

  expect(deleteProject(db, project.id).deleted).toBeTrue()

  expect(liveRows(content, defaultId).map(thought => thought.id)).toEqual([movedId])
  const archived = row(settledId)
  expect(archived.status).toBe('archived')
  expect(archived.archived_at).not.toBeNull()
  expect(archived.is_protected).toBe(1)
  expect(row(movedId).content_hash).toBe(computeContentHash(content, defaultId))
})

test('two live duplicates inside the deleted project collapse to the oldest after the move', () => {
  const db = getDb()
  const defaultId = resolveDefaultProjectId(db)
  const project = createProject(db, { name: 'Doomed' })
  const content = 'shared body'
  const oldestId = seedWithHash(content, project.id, OLDER, 'legacy-hash-oldest')
  const newerId = seedWithHash(content, project.id, NEWER, 'legacy-hash-newer')

  expect(deleteProject(db, project.id).deleted).toBeTrue()

  expect(liveRows(content, defaultId).map(thought => thought.id)).toEqual([oldestId])
  const archived = row(newerId)
  expect(archived.project_id).toBe(defaultId)
  expect(archived.status).toBe('archived')
  expect(archived.archived_at).not.toBeNull()
  expect(archived.is_protected).toBe(1)
  expect(archived.content_hash).toBe(computeContentHash(content, defaultId))
})

test('a failing move leaves the project and its thoughts untouched', () => {
  const db = getDb()
  const defaultId = resolveDefaultProjectId(db)
  const project = createProject(db, { name: 'Kept' })
  const content = 'shared body'
  const settledId = seedLive(content, defaultId, OLDER)
  const movedId = seedLive(content, project.id, NEWER)

  db.run(`CREATE TRIGGER fail_project_move BEFORE UPDATE OF project_id ON thoughts
    WHEN OLD.project_id = '${project.id}'
    BEGIN SELECT RAISE(ABORT, 'simulated move failure'); END`)

  expect(() => deleteProject(db, project.id)).toThrow('simulated move failure')

  expect(getProject(db, project.id)).toBeDefined()
  const settled = row(settledId)
  expect(settled.status).toBe('active')
  expect(settled.is_protected).toBe(1)
  const moving = row(movedId)
  expect(moving.status).toBe('active')
  expect(moving.project_id).toBe(project.id)
  expect(moving.content_hash).toBe(computeContentHash(content, project.id))
})
