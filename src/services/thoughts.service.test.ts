import { afterEach, beforeEach, expect, test } from 'bun:test'
import { config } from '../config'
import { getDb } from '../db'
import { getThoughtLimits } from '../db/settings'
import { createTestDb, seedEdge, seedThought } from '../test/helpers'
import { NotFoundError, ValidationError } from '../errors'
import {
  archiveThoughtByIdService,
  createThoughtWithParentService,
  getClusterMembersService,
  getThoughtByIdService,
  listThoughtsService,
  updateThoughtByIdService
} from './thoughts.service'
import { createThoughtWithUrlLinksService } from './url_links.service'
import { mergeThoughtsService } from './merge.service'
import { validateContentLength } from '../validation'

// The thought limits are config-only since task #2201.
const originalSoftLimit = config.thoughts.softLimit
const originalHardLimitBufferPercent = config.thoughts.hardLimitBufferPercent

beforeEach(createTestDb)
afterEach(() => {
  const { closeDb } = require('../db/init')
  closeDb()
  config.thoughts.softLimit = originalSoftLimit
  config.thoughts.hardLimitBufferPercent = originalHardLimitBufferPercent
})

test('getThoughtByIdService returns thought', () => {
  const id = seedThought({ content: 'hello' })
  const t = getThoughtByIdService(id)
  expect(t).not.toBeNull()
  expect(t!.content).toBe('hello')
})

test('getThoughtByIdService returns null for unknown id', () => {
  expect(getThoughtByIdService('nonexistent')).toBeNull()
})

test('createThoughtWithParentService creates thought without parent', () => {
  const t = createThoughtWithParentService({ content: 'test thought', tags: ['tag1'] })
  expect(t.id).toBeString()
  expect(t.content).toBe('test thought')
  expect(t.tags).toHaveLength(1)
  expect((t as unknown as Record<string, unknown>).content_language).toBe('en')
})

test('createThoughtWithParentService creates thought with parent edge', () => {
  const parentId = seedThought()
  const child = createThoughtWithParentService({ content: 'child' }, parentId, 'develops')
  const db = getDb()
  const edges = db.prepare('SELECT * FROM edges WHERE source_id = ? AND target_id = ?').all(parentId, child.id)
  expect(edges).toHaveLength(1)
  expect((edges[0] as { type: string }).type).toBe('develops')
})

test('createThoughtWithParentService validates status', () => {
  expect(() => createThoughtWithParentService({ content: 'x', status: 'bogus' as any })).toThrow(ValidationError)
})

test('createThoughtWithParentService rejects content over hard limit', () => {
  const longContent = 'x'.repeat(100_001)
  expect(() => createThoughtWithParentService({ content: longContent })).toThrow(ValidationError)
})

test('updateThoughtByIdService updates content', () => {
  const id = seedThought()
  const updated = updateThoughtByIdService(id, { content: 'updated' })
  expect(updated).not.toBeNull()
  expect(updated!.content).toBe('updated')
  expect((updated! as unknown as Record<string, unknown>).content_language).toBe('en')
})

test('updateThoughtByIdService returns null for unknown id', () => {
  expect(updateThoughtByIdService('nonexistent', { content: 'x' })).toBeNull()
})

test('updateThoughtByIdService validates status', () => {
  const id = seedThought()
  expect(() => updateThoughtByIdService(id, { status: 'bogus' as any })).toThrow(ValidationError)
})

test('archiveThoughtByIdService archives active thought', () => {
  const id = seedThought({ status: 'active' })
  const result = archiveThoughtByIdService(id)
  expect(result).not.toBeNull()
  expect(result!.status).toBe('archived')
})

test('archiveThoughtByIdService returns null for unknown id', () => {
  expect(archiveThoughtByIdService('nonexistent')).toBeNull()
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

test('getClusterMembersService throws for non-cluster thought', () => {
  const id = seedThought()
  expect(() => getClusterMembersService(id)).toThrow(ValidationError)
})

test('getClusterMembersService throws for unknown id', () => {
  expect(() => getClusterMembersService('nonexistent')).toThrow(NotFoundError)
})

test('mergeThoughtsService throws for same source and target', () => {
  const id = seedThought()
  expect(() => mergeThoughtsService({ targetId: id, sourceId: id })).toThrow(ValidationError)
})

test('mergeThoughtsService throws for missing source', () => {
  const target = seedThought()
  expect(() => mergeThoughtsService({ targetId: target, sourceId: 'nonexistent' })).toThrow(NotFoundError)
})

test('mergeThoughtsService throws for missing target', () => {
  const source = seedThought()
  expect(() => mergeThoughtsService({ targetId: 'nonexistent', sourceId: source })).toThrow(NotFoundError)
})

test('mergeThoughtsService throws for archived source', () => {
  const source = seedThought({ status: 'archived' })
  const target = seedThought()
  expect(() => mergeThoughtsService({ targetId: target, sourceId: source })).toThrow(ValidationError)
})

test('mergeThoughtsService merges content and transfers edges', () => {
  const source = seedThought({ content: 'source thought' })
  const target = seedThought({ content: 'target thought' })
  const third = seedThought()
  seedEdge(source, third, 'related')
  const result = mergeThoughtsService({ targetId: target, sourceId: source, mergedContent: 'merged content', mergedTags: ['tag1'] })
  expect(result.target.content).toBe('merged content')
  expect(result.transferredEdges).toBe(1)
  // Source should be archived
  const srcAfter = getThoughtByIdService(source)
  expect(srcAfter!.status).toBe('archived')
  // Archived source must not retain any output edges — they were cleaned up
  // during edge transfer (issue #98).
  const db = getDb()
  const leftoverEdges = db.prepare('SELECT 1 FROM edges WHERE source_id = ?').all(source)
  expect(leftoverEdges).toHaveLength(0)
})

test('mergeThoughtsService handles preview mode (no content/tags)', () => {
  const source = seedThought({ content: 'source' })
  const target = seedThought({ content: 'target' })
  // When no mergedContent and no mergedTags, it should do an update with empty object
  const result = mergeThoughtsService({ targetId: target, sourceId: source })
  expect(result.target.id).toBe(target)
  expect(result.transferredEdges).toBe(0)
})

test('createThoughtWithUrlLinksService creates thought with links', () => {
  const t = createThoughtWithUrlLinksService(
    { content: 'with links' },
    { urlLinks: [{ text: 'google', url: 'http://google.com' }] }
  )
  expect(t.id).toBeString()
  const db = getDb()
  const links = db.prepare('SELECT * FROM thought_url_links WHERE thought_id = ?').all(t.id)
  expect(links).toHaveLength(1)
})

test('validateContentLength does not throw under soft limit', () => {
  expect(() => validateContentLength('short', getThoughtLimits(getDb()))).not.toThrow()
})

// ── Padded hard-limit boundary (issue #123) ─────────────────────────────────

test('createThoughtWithParentService accepts content exactly at the derived hard limit', () => {
  config.thoughts.softLimit = 10 // soft 10 -> hard 15
  config.thoughts.hardLimitBufferPercent = 50
  const { hardLimit } = getThoughtLimits(getDb())
  expect(hardLimit).toBe(15)

  const thought = createThoughtWithParentService({ content: 'x'.repeat(hardLimit) })
  expect(thought.content).toHaveLength(hardLimit)
})

test('createThoughtWithParentService rejects content one char over the derived hard limit', () => {
  config.thoughts.softLimit = 10 // soft 10 -> hard 15
  config.thoughts.hardLimitBufferPercent = 50
  const { hardLimit } = getThoughtLimits(getDb())

  expect(() => createThoughtWithParentService({ content: 'x'.repeat(hardLimit + 1) })).toThrow(ValidationError)
})

test('content between soft and hard limit is accepted (soft limit is advisory)', () => {
  config.thoughts.softLimit = 10 // soft 10 -> hard 15
  config.thoughts.hardLimitBufferPercent = 50
  const { softLimit, hardLimit } = getThoughtLimits(getDb())
  const middle = softLimit + 1
  expect(middle).toBeGreaterThan(softLimit)
  expect(middle).toBeLessThan(hardLimit)

  expect(() => createThoughtWithParentService({ content: 'x'.repeat(middle) })).not.toThrow()
})

test('updateThoughtByIdService enforces the derived hard limit and accepts the exact ceiling', () => {
  const id = seedThought({ content: 'short' })
  config.thoughts.softLimit = 10 // soft 10 -> hard 15
  config.thoughts.hardLimitBufferPercent = 50
  const { hardLimit } = getThoughtLimits(getDb())

  expect(() => updateThoughtByIdService(id, { content: 'x'.repeat(hardLimit + 1) })).toThrow(ValidationError)
  expect(updateThoughtByIdService(id, { content: 'x'.repeat(hardLimit) })?.content).toHaveLength(hardLimit)
})
