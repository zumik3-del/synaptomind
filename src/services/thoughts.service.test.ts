import { afterEach, beforeEach, expect, test } from 'bun:test'
import { getDb } from '../db'
import { createTestDb, seedEdge, seedThought } from '../test/helpers'
import { NotFoundError, ValidationError } from './errors'
import {
  archiveThoughtById,
  createThoughtWithParent,
  createThoughtWithUrlLinks,
  deleteThoughtById,
  findClusterForThought,
  getClusterMembersService,
  getThoughtById,
  listThoughtsService,
  mergeThoughtsService,
  pruneThoughtUrlLinksService,
  updateThoughtById,
  validateContentLength
} from './thoughts.service'

beforeEach(createTestDb)
afterEach(() => {
  const { closeDb } = require('../db/init')
  closeDb()
})

test('getThoughtById returns thought', () => {
  const id = seedThought({ content: 'hello' })
  const t = getThoughtById(id)
  expect(t).not.toBeNull()
  expect(t!.content).toBe('hello')
})

test('getThoughtById returns null for unknown id', () => {
  expect(getThoughtById('nonexistent')).toBeNull()
})

test('createThoughtWithParent creates thought without parent', () => {
  const t = createThoughtWithParent({ content: 'test thought', tags: ['tag1'] })
  expect(t.id).toBeString()
  expect(t.content).toBe('test thought')
  expect(t.tags).toHaveLength(1)
})

test('createThoughtWithParent creates thought with parent edge', () => {
  const parentId = seedThought()
  const child = createThoughtWithParent({ content: 'child' }, parentId, 'develops')
  const db = getDb()
  const edges = db.prepare('SELECT * FROM edges WHERE source_id = ? AND target_id = ?').all(parentId, child.id)
  expect(edges).toHaveLength(1)
  expect((edges[0] as { type: string }).type).toBe('develops')
})

test('createThoughtWithParent validates status', () => {
  expect(() => createThoughtWithParent({ content: 'x', status: 'bogus' as any })).toThrow(ValidationError)
})

test('createThoughtWithParent rejects content over hard limit', () => {
  const longContent = 'x'.repeat(100_001)
  expect(() => createThoughtWithParent({ content: longContent })).toThrow(ValidationError)
})

test('updateThoughtById updates content', () => {
  const id = seedThought()
  const updated = updateThoughtById(id, { content: 'updated' })
  expect(updated).not.toBeNull()
  expect(updated!.content).toBe('updated')
})

test('updateThoughtById returns null for unknown id', () => {
  expect(updateThoughtById('nonexistent', { content: 'x' })).toBeNull()
})

test('updateThoughtById validates status', () => {
  const id = seedThought()
  expect(() => updateThoughtById(id, { status: 'bogus' as any })).toThrow(ValidationError)
})

test('archiveThoughtById archives active thought', () => {
  const id = seedThought({ status: 'active' })
  const result = archiveThoughtById(id)
  expect(result).not.toBeNull()
  expect(result!.status).toBe('archived')
})

test('archiveThoughtById returns null for unknown id', () => {
  expect(archiveThoughtById('nonexistent')).toBeNull()
})

test('archiveThoughtById rejects profile thoughts', () => {
  const id = seedThought({ is_profile: 1, status: 'active' })
  expect(() => archiveThoughtById(id)).toThrow(ValidationError)
})

test('deleteThoughtById removes thought', () => {
  const id = seedThought()
  expect(deleteThoughtById(id)).toBeTrue()
  expect(getThoughtById(id)).toBeNull()
})

test('deleteThoughtById returns false for unknown', () => {
  expect(deleteThoughtById('nonexistent')).toBeFalse()
})

test('listThoughtsService returns thoughts', () => {
  seedThought({ content: 'first' })
  seedThought({ content: 'second' })
  const list = listThoughtsService()
  expect(list.length).toBeGreaterThanOrEqual(2)
})

test('listThoughtsService filters by status', () => {
  seedThought({ content: 'active1', status: 'active' })
  seedThought({ content: 'draft1', status: 'draft' })
  const active = listThoughtsService({ status: 'active' })
  expect(active.every(t => t.status === 'active')).toBeTrue()
})

test('findClusterForThought returns null for non-clustered thought', () => {
  const id = seedThought()
  expect(findClusterForThought(id)).toBeNull()
})

test('getClusterMembersService throws for non-cluster thought', () => {
  const id = seedThought()
  expect(() => getClusterMembersService(id)).toThrow(ValidationError)
})

test('getClusterMembersService throws for unknown id', () => {
  expect(() => getClusterMembersService('nonexistent')).toThrow(NotFoundError)
})

test('pruneThoughtUrlLinksService removes links not in content', () => {
  const id = seedThought()
  const db = getDb()
  db.prepare(`INSERT INTO thought_url_links (thought_id, key, url, label, sort_order, created_at) VALUES (?, ?, ?, ?, ?, ?)`).run(id, 'link1', 'http://a.com', 'link1', 0, new Date().toISOString())
  const pruned = pruneThoughtUrlLinksService(id, 'no links here')
  expect(pruned).toBe(1)
})

test('mergeThoughtsService throws for same source and target', () => {
  const id = seedThought()
  expect(() => mergeThoughtsService(id, id)).toThrow(ValidationError)
})

test('mergeThoughtsService throws for missing source', () => {
  const target = seedThought()
  expect(() => mergeThoughtsService(target, 'nonexistent')).toThrow(NotFoundError)
})

test('mergeThoughtsService throws for missing target', () => {
  const source = seedThought()
  expect(() => mergeThoughtsService('nonexistent', source)).toThrow(NotFoundError)
})

test('mergeThoughtsService throws for archived source', () => {
  const source = seedThought({ status: 'archived' })
  const target = seedThought()
  expect(() => mergeThoughtsService(target, source)).toThrow(ValidationError)
})

test('mergeThoughtsService throws for profile source', () => {
  const source = seedThought({ is_profile: 1 })
  const target = seedThought()
  expect(() => mergeThoughtsService(target, source)).toThrow(ValidationError)
})

test('mergeThoughtsService merges content and transfers edges', () => {
  const source = seedThought({ content: 'source thought' })
  const target = seedThought({ content: 'target thought' })
  const third = seedThought()
  seedEdge(source, third, 'related')
  const result = mergeThoughtsService(target, source, 'merged content', ['tag1'])
  expect(result.target.content).toBe('merged content')
  expect(result.transferredEdges).toBe(1)
  // Source should be archived
  const srcAfter = getThoughtById(source)
  expect(srcAfter!.status).toBe('archived')
})

test('mergeThoughtsService handles preview mode (no content/tags)', () => {
  const source = seedThought({ content: 'source' })
  const target = seedThought({ content: 'target' })
  // When no mergedContent and no mergedTags, it should do an update with empty object
  const result = mergeThoughtsService(target, source)
  expect(result.target.id).toBe(target)
  expect(result.transferredEdges).toBe(0)
})

test('createThoughtWithUrlLinks creates thought with links', () => {
  const t = createThoughtWithUrlLinks(
    { content: 'with links' },
    { urlLinks: [{ text: 'google', url: 'http://google.com' }] }
  )
  expect(t.id).toBeString()
  const db = getDb()
  const links = db.prepare('SELECT * FROM thought_url_links WHERE thought_id = ?').all(t.id)
  expect(links).toHaveLength(1)
})

test('validateContentLength does not throw under soft limit', () => {
  expect(() => validateContentLength('short')).not.toThrow()
})
