import { afterEach, beforeEach, expect, test } from 'bun:test'
import { createTestDb, seedThought } from '../test/helpers'
import { closeDb, getDb } from '../db'
import { getFrontier } from './frontier.service'

beforeEach(createTestDb)
afterEach(closeDb)

function tagThought(id: string, tag: string): void {
  const db = getDb()
  let tagRow = db.prepare('SELECT id FROM tags WHERE name = ?').get(tag) as { id: string } | undefined
  if (!tagRow) {
    const { v7: uuidv7 } = require('uuid')
    const tagId = uuidv7()
    db.prepare('INSERT INTO tags (id, name, created_at) VALUES (?, ?, ?)').run(tagId, tag, new Date().toISOString())
    tagRow = { id: tagId }
  }
  db.prepare('INSERT OR IGNORE INTO thought_tags (thought_id, tag_id) VALUES (?, ?)').run(id, tagRow.id)
}

test('getFrontier returns empty when no candidates', () => {
  const result = getFrontier()
  expect(result.items).toEqual([])
})

test('getFrontier includes directive-tagged thoughts', () => {
  const id = seedThought({ content: 'do this thing' })
  tagThought(id, 'directive')
  const result = getFrontier()
  expect(result.items).toHaveLength(1)
  expect(result.items[0].thought_id).toBe(id)
  expect(result.items[0].reason).toBe('directive')
})

test('getFrontier includes todo-tagged thoughts', () => {
  const id = seedThought({ content: 'todo item' })
  tagThought(id, 'todo')
  const result = getFrontier()
  expect(result.items).toHaveLength(1)
})

test('getFrontier excludes clusters', () => {
  const id = seedThought({ content: 'cluster', is_cluster: 1 })
  tagThought(id, 'directive')
  const result = getFrontier()
  expect(result.items).toHaveLength(0)
})

test('getFrontier excludes profile-summary source', () => {
  const id = seedThought({ content: 'profile', source: 'profile-summary' })
  tagThought(id, 'directive')
  const result = getFrontier()
  expect(result.items).toHaveLength(0)
})

test('getFrontier excludes crystal source', () => {
  const id = seedThought({ content: 'crystal', source: 'crystal' })
  tagThought(id, 'directive')
  const result = getFrontier()
  expect(result.items).toHaveLength(0)
})

test('getFrontier excludes replaced thoughts', () => {
  const a = seedThought({ content: 'old' })
  const b = seedThought({ content: 'new' })
  tagThought(a, 'directive')
  tagThought(b, 'directive')
  const db = getDb()
  db.prepare("INSERT INTO edges (id, source_id, target_id, type, created_at) VALUES (?, ?, ?, 'replaces', ?)").run('e1', b, a, new Date().toISOString())
  const result = getFrontier()
  expect(result.items.find(i => i.thought_id === a)).toBeUndefined()
  expect(result.items.find(i => i.thought_id === b)).toBeDefined()
})

test('getFrontier respects k limit', () => {
  for (let i = 0; i < 5; i++) {
    const id = seedThought({ content: `thought ${i}` })
    tagThought(id, 'directive')
  }
  const result = getFrontier({ k: 2 })
  expect(result.items).toHaveLength(2)
})

test('getFrontier filters by project_id', () => {
  const id = seedThought({ content: 'project thought', project_id: 'proj-x' })
  tagThought(id, 'directive')
  seedThought({ content: 'other project', project_id: 'proj-y' })
  const result = getFrontier({ project_id: 'proj-x' })
  expect(result.items).toHaveLength(1)
  expect(result.items[0].thought_id).toBe(id)
})

test('getFrontier priority ranges 0-1', () => {
  const id = seedThought({ content: 'thought' })
  tagThought(id, 'directive')
  const result = getFrontier()
  expect(result.items[0].priority).toBeGreaterThanOrEqual(0)
  expect(result.items[0].priority).toBeLessThanOrEqual(1)
})

test('getFrontier content_short truncates long content', () => {
  const long = 'x'.repeat(200)
  const id = seedThought({ content: long })
  tagThought(id, 'directive')
  const result = getFrontier()
  expect(result.items[0].content_short.length).toBeLessThanOrEqual(121)
  expect(result.items[0].content_short).toEndWith('…')
})

test('getFrontier uses depends_on for blocking', () => {
  const a = seedThought({ content: 'blocker' })
  const b = seedThought({ content: 'blocked' })
  tagThought(a, 'directive')
  tagThought(b, 'directive')
  const db = getDb()
  db.prepare("INSERT INTO edges (id, source_id, target_id, type, created_at) VALUES (?, ?, ?, 'depends_on', ?)").run('e1', a, b, new Date().toISOString())
  const result = getFrontier()
  const itemA = result.items.find(i => i.thought_id === a)
  const itemB = result.items.find(i => i.thought_id === b)
  expect(itemA).toBeDefined()
  expect(itemB).toBeDefined()
  expect(itemA!.blocked_by).toEqual([])
  expect(itemB!.blocked_by).toContain(a)
  expect(itemA!.priority).toBeGreaterThan(itemB!.priority)
})

test('getFrontier does not block via develops edge', () => {
  const a = seedThought({ content: 'evolved' })
  const b = seedThought({ content: 'evolution' })
  tagThought(a, 'directive')
  tagThought(b, 'directive')
  const db = getDb()
  db.prepare("INSERT INTO edges (id, source_id, target_id, type, created_at) VALUES (?, ?, ?, 'develops', ?)").run('e1', a, b, new Date().toISOString())
  const result = getFrontier()
  const itemB = result.items.find(i => i.thought_id === b)
  expect(itemB).toBeDefined()
  expect(itemB!.blocked_by).toEqual([])
})
