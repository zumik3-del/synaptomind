import { afterEach, beforeEach, expect, test } from 'bun:test'
import { createTestDb, seedThought } from '../test/helpers'
import { closeDb, getDb } from './index'
import { findDirectiveCandidates, FRONTIER_EXCLUDED_SOURCES } from './frontier'

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

test('findDirectiveCandidates returns directive-tagged active thoughts', () => {
  const id = seedThought({ content: 'do this' })
  tagThought(id, 'directive')
  const rows = findDirectiveCandidates(getDb())
  expect(rows).toHaveLength(1)
  expect(rows[0]!.id).toBe(id)
})

test('findDirectiveCandidates returns todo-tagged thoughts', () => {
  const id = seedThought({ content: 'todo item' })
  tagThought(id, 'todo')
  const rows = findDirectiveCandidates(getDb())
  expect(rows).toHaveLength(1)
  expect(rows[0]!.id).toBe(id)
})

test('findDirectiveCandidates excludes clusters', () => {
  const id = seedThought({ content: 'cluster', is_cluster: 1 })
  tagThought(id, 'directive')
  const rows = findDirectiveCandidates(getDb())
  expect(rows).toHaveLength(0)
})

test('findDirectiveCandidates excludes profile-summary source', () => {
  const id = seedThought({ content: 'profile', source: 'profile-summary' })
  tagThought(id, 'directive')
  const rows = findDirectiveCandidates(getDb())
  expect(rows).toHaveLength(0)
})

test('findDirectiveCandidates excludes crystal source', () => {
  const id = seedThought({ content: 'crystal', source: 'crystal' })
  tagThought(id, 'directive')
  const rows = findDirectiveCandidates(getDb())
  expect(rows).toHaveLength(0)
})

test('findDirectiveCandidates respects project filter', () => {
  const a = seedThought({ content: 'proj a', project_id: 'proj-x' })
  const b = seedThought({ content: 'proj b', project_id: 'proj-y' })
  tagThought(a, 'directive')
  tagThought(b, 'directive')
  const rows = findDirectiveCandidates(getDb(), 'proj-x')
  expect(rows).toHaveLength(1)
  expect(rows[0]!.id).toBe(a)
})

test('findDirectiveCandidates returns empty when no candidates', () => {
  const rows = findDirectiveCandidates(getDb())
  expect(rows).toEqual([])
})

test('findDirectiveCandidates excludes draft cluster', () => {
  const id = seedThought({ content: 'draft cluster', status: 'draft', is_cluster: 1 })
  tagThought(id, 'directive')
  const rows = findDirectiveCandidates(getDb())
  expect(rows).toHaveLength(0)
})

test('findDirectiveCandidates includes draft (non-cluster) thoughts', () => {
  const id = seedThought({ content: 'draft directive', status: 'draft' })
  tagThought(id, 'directive')
  const rows = findDirectiveCandidates(getDb())
  expect(rows).toHaveLength(1)
  expect(rows[0]!.id).toBe(id)
})
