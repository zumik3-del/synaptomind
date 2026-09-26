import { afterEach, beforeEach, expect, test } from 'bun:test'
import { createTestDb, seedThought } from '../test/helpers'
import { closeDb, getDb } from './index'
import { findFrontierCandidates, FRONTIER_EXCLUDED_SOURCES } from './frontier'

beforeEach(createTestDb)
afterEach(closeDb)

function tagThought(id: string, tag: string): void {
  const db = getDb()
  let tagRow = db.prepare('SELECT id FROM tags WHERE name = ?').get(tag) as { id: string } | undefined
  if (!tagRow) {
    const tagId = Bun.randomUUIDv7()
    db.prepare('INSERT INTO tags (id, name, created_at) VALUES (?, ?, ?)').run(tagId, tag, new Date().toISOString())
    tagRow = { id: tagId }
  }
  db.prepare('INSERT OR IGNORE INTO thought_tags (thought_id, tag_id) VALUES (?, ?)').run(id, tagRow.id)
}

test('FRONTIER_EXCLUDED_SOURCES lists profile-summary and crystal', () => {
  expect(FRONTIER_EXCLUDED_SOURCES).toEqual(['profile-summary', 'crystal'])
})

test('findFrontierCandidates returns directive-tagged active thoughts', () => {
  const id = seedThought({ content: 'do this' })
  tagThought(id, 'directive')
  const rows = findFrontierCandidates(getDb())
  expect(rows).toHaveLength(1)
  expect(rows[0]!.id).toBe(id)
})

test('findFrontierCandidates returns todo-tagged thoughts', () => {
  const id = seedThought({ content: 'todo item' })
  tagThought(id, 'todo')
  const rows = findFrontierCandidates(getDb())
  expect(rows).toHaveLength(1)
  expect(rows[0]!.id).toBe(id)
})

test('findFrontierCandidates excludes clusters', () => {
  const id = seedThought({ content: 'cluster', is_cluster: 1 })
  tagThought(id, 'directive')
  const rows = findFrontierCandidates(getDb())
  expect(rows).toHaveLength(0)
})

test('findFrontierCandidates excludes profile-summary source', () => {
  const id = seedThought({ content: 'profile', source: 'profile-summary' })
  tagThought(id, 'directive')
  const rows = findFrontierCandidates(getDb())
  expect(rows).toHaveLength(0)
})

test('findFrontierCandidates excludes crystal source', () => {
  const id = seedThought({ content: 'crystal', source: 'crystal' })
  tagThought(id, 'directive')
  const rows = findFrontierCandidates(getDb())
  expect(rows).toHaveLength(0)
})

test('findFrontierCandidates respects project filter', () => {
  const a = seedThought({ content: 'proj a', project_id: 'proj-x' })
  const b = seedThought({ content: 'proj b', project_id: 'proj-y' })
  tagThought(a, 'directive')
  tagThought(b, 'directive')
  const rows = findFrontierCandidates(getDb(), 'proj-x')
  expect(rows).toHaveLength(1)
  expect(rows[0]!.id).toBe(a)
})

test('findFrontierCandidates returns empty when no candidates', () => {
  const rows = findFrontierCandidates(getDb())
  expect(rows).toEqual([])
})

test('findFrontierCandidates excludes draft cluster', () => {
  const id = seedThought({ content: 'draft cluster', status: 'draft', is_cluster: 1 })
  tagThought(id, 'directive')
  const rows = findFrontierCandidates(getDb())
  expect(rows).toHaveLength(0)
})

test('findFrontierCandidates includes draft (non-cluster) thoughts', () => {
  const id = seedThought({ content: 'draft directive', status: 'draft' })
  tagThought(id, 'directive')
  const rows = findFrontierCandidates(getDb())
  expect(rows).toHaveLength(1)
  expect(rows[0]!.id).toBe(id)
})

test('findFrontierCandidates returns is_pending=1 for pending-tagged thoughts', () => {
  const id = seedThought({ content: 'pending item' })
  tagThought(id, 'pending')
  const rows = findFrontierCandidates(getDb())
  expect(rows).toHaveLength(1)
  expect(rows[0]!.is_pending).toBe(1)
})

test('findFrontierCandidates returns is_pending=0 for non-pending thoughts', () => {
  const id = seedThought({ content: 'directive item' })
  tagThought(id, 'directive')
  const rows = findFrontierCandidates(getDb())
  expect(rows).toHaveLength(1)
  expect(rows[0]!.is_pending).toBe(0)
})

test('findFrontierCandidates excludes pending with future surface_after', () => {
  const future = new Date(Date.now() + 7 * 86_400_000).toISOString()
  const id = seedThought({ content: 'not yet', tags: '["pending"]', surface_after: future })
  tagThought(id, 'pending')
  const rows = findFrontierCandidates(getDb())
  expect(rows).toHaveLength(0)
})

test('findFrontierCandidates includes pending with past surface_after', () => {
  const past = new Date(Date.now() - 86_400_000).toISOString()
  const id = seedThought({ content: 'due pending', tags: '["pending"]', surface_after: past })
  tagThought(id, 'pending')
  const rows = findFrontierCandidates(getDb())
  expect(rows).toHaveLength(1)
  expect(rows[0]!.id).toBe(id)
})

test('findFrontierCandidates includes pending with NULL surface_after', () => {
  const id = seedThought({ content: 'null pending', tags: '["pending"]', surface_after: null })
  tagThought(id, 'pending')
  const rows = findFrontierCandidates(getDb())
  expect(rows).toHaveLength(1)
  expect(rows[0]!.id).toBe(id)
})

test('migrated DB has no smart_notes table', () => {
  const db = getDb()
  const table = db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='smart_notes'").get() as { name: string } | null
  expect(table).toBeNull()
})
