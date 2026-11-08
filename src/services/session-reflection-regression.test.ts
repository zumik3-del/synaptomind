import { afterEach, beforeEach, expect, test } from 'bun:test'
import { closeDb, getDb } from '../db'
import { createThought, getThought } from '../db/thoughts'
import { createTestDb } from '../test/helpers'
import { reflectSessionService } from './session-reflection.service'

beforeEach(createTestDb)
afterEach(closeDb)

function project(id: string): void {
  getDb().prepare('INSERT INTO projects (id, name, created_at) VALUES (?, ?, ?)').run(id, id, new Date().toISOString())
}

test('pending duplicate preserves existing thought and counts only new entries', () => {
  const db = getDb()
  project('one')
  const original = createThought(db, { content: 'Existing task', project_id: 'one', status: 'active', tags: ['custom'], surface_after: '2030-01-01T00:00:00.000Z' })
  const before = getThought(db, original.id)
  const result = reflectSessionService({ project_id: 'one', pending: [' Existing task ', 'New task', 'New task'], wake_days: 1 })
  expect(result.pending_created).toBe(1)
  expect(getThought(db, original.id)).toEqual(before)
  expect(db.prepare("SELECT count(*) AS n FROM thoughts WHERE project_id = 'one'").get()).toEqual({ n: 2 })
})

test('exact non-decision collisions do not retag existing thoughts', () => {
  const db = getDb()
  const original = createThought(db, { content: 'Keep this unchanged', status: 'draft', tags: ['custom'] })
  const before = getThought(db, original.id)
  const result = reflectSessionService({ decisions: ['Keep this unchanged'], pending: ['Keep this unchanged'] })
  expect(result.decisions_created).toBe(0)
  expect(result.pending_created).toBe(0)
  expect(getThought(db, original.id)).toEqual(before)
})

test('same-call similar decisions are counted once', () => {
  const result = reflectSessionService({ decisions: ['We decided to use SQLite', 'We have decided to use sqlite'] })
  expect(result.decisions_created).toBe(1)
})

test('pending content is deduplicated only against live thoughts in the same project', () => {
  const db = getDb()
  project('one')
  project('two')
  createThought(db, { content: 'Archived task', project_id: 'one', status: 'archived' })
  createThought(db, { content: 'Other project task', project_id: 'two', status: 'draft' })
  expect(reflectSessionService({ project_id: 'one', pending: ['Archived task', 'Other project task'] }).pending_created).toBe(2)
})

test('similar decisions are scoped to their project including the default project', () => {
  project('one')
  project('two')
  expect(reflectSessionService({ project_id: 'one', decisions: ['We decided to use SQLite'] }).decisions_created).toBe(1)
  expect(reflectSessionService({ project_id: 'one', decisions: ['We have decided to use sqlite'] }).decisions_created).toBe(0)
  expect(reflectSessionService({ project_id: 'two', decisions: ['We have decided to use sqlite'] }).decisions_created).toBe(1)
  expect(reflectSessionService({ decisions: ['We have decided to use sqlite'] }).decisions_created).toBe(1)
  expect(reflectSessionService({ decisions: ['We decided to use SQLite'] }).decisions_created).toBe(0)
})

test('draft decisions deduplicate and archived decisions do not', () => {
  const db = getDb()
  createThought(db, { content: 'Adopt SQLite storage', status: 'draft', tags: ['decision'] })
  createThought(db, { content: 'Deploy Postgres database', status: 'archived', tags: ['decision'] })
  expect(reflectSessionService({ decisions: ['Adopt SQLite storage'] }).decisions_created).toBe(0)
  expect(reflectSessionService({ decisions: ['Deploy Postgres database'] }).decisions_created).toBe(1)
})

test('global flag does not make a decision block reflection in another project', () => {
  const db = getDb()
  project('one')
  project('two')
  createThought(db, { content: 'Use SQLite for storage', project_id: 'one', is_global: true, status: 'active', tags: ['decision'] })
  expect(reflectSessionService({ project_id: 'two', decisions: ['Use SQLite for storage'] }).decisions_created).toBe(1)
})

test('validation failure rolls back summary, goals, decisions and pending writes', () => {
  const db = getDb()
  expect(() => reflectSessionService({ summary: 'rollback', goals_add: ['rollback'], decisions: ['rollback decision'], pending: ['rollback task', ''] })).toThrow()
  expect(db.prepare("SELECT count(*) AS n FROM thoughts WHERE source = 'session-reflection'").get()).toEqual({ n: 0 })
  expect(db.prepare("SELECT count(*) AS n FROM slots WHERE content LIKE '%rollback%'").get()).toEqual({ n: 0 })
})
