import { afterEach, beforeEach, expect, test } from 'bun:test'
import { createTestDb, seedThought } from '../test/helpers'
import { getDb } from './container'
import { closeDb } from './init'
import { findActiveDecisionThoughts } from './session-reflection'

beforeEach(createTestDb)
afterEach(closeDb)

function ensureDecisionTag(db: ReturnType<typeof getDb>): string {
  let tag = db.prepare("SELECT id FROM tags WHERE name = 'decision'").get() as { id: string } | undefined
  if (!tag) {
    tag = { id: Bun.randomUUIDv7() }
    db.prepare('INSERT INTO tags (id, name, created_at) VALUES (?, ?, ?)').run(
      tag.id, 'decision', new Date().toISOString()
    )
  }
  return tag.id
}

test('findActiveDecisionThoughts returns thoughts tagged decision', () => {
  const db = getDb()
  const tagId = ensureDecisionTag(db)
  const a = seedThought({ content: 'decision one' })
  const b = seedThought({ content: 'decision two' })
  db.prepare('INSERT INTO thought_tags (thought_id, tag_id) VALUES (?, ?)').run(a, tagId)
  db.prepare('INSERT INTO thought_tags (thought_id, tag_id) VALUES (?, ?)').run(b, tagId)
  seedThought({ content: 'not a decision' })

  const candidates = findActiveDecisionThoughts(db)
  expect(candidates.map(c => c.id)).toContain(a)
  expect(candidates.map(c => c.id)).toContain(b)
})

test('findActiveDecisionThoughts excludes archived decisions', () => {
  const db = getDb()
  const tagId = ensureDecisionTag(db)
  const active = seedThought({ content: 'active decision' })
  const archived = seedThought({ content: 'archived decision', status: 'archived' })
  db.prepare('INSERT INTO thought_tags (thought_id, tag_id) VALUES (?, ?)').run(active, tagId)
  db.prepare('INSERT INTO thought_tags (thought_id, tag_id) VALUES (?, ?)').run(archived, tagId)

  const candidates = findActiveDecisionThoughts(db)
  expect(candidates.map(c => c.id)).toContain(active)
  expect(candidates.find(c => c.id === archived)).toBeUndefined()
})

test('findActiveDecisionThoughts returns empty when no decision-tagged thoughts', () => {
  seedThought({ content: 'plain thought' })
  expect(findActiveDecisionThoughts(getDb())).toEqual([])
})
