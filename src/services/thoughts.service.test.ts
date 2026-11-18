import { afterEach, beforeEach, expect, test } from 'bun:test'
import { config } from '../config'
import { getDb } from '../db'
import { getThoughtLimitsDB } from '../db/settings'
import { createTestDb, seedEdge, seedThought } from '../test/helpers'
import { NotFoundError, ThoughtContentConflictError, ValidationError } from '../errors'
import {
  archiveThoughtByIdService,
  archiveThoughtsBatchService,
  createThoughtWithParentService,
  getThoughtByIdService,
  listThoughtsPageService,
  updateThoughtByIdService
} from './thoughts.service'
import { createThoughtWithUrlLinksService } from './url_links.service'
import { mergeThoughtsService } from './merge.service'
import { BATCH_ITEMS_MAX, validateContentLength } from '../validation'

const originalSoftLimit = config.thoughts.softLimit
const originalHardLimitBufferPercent = config.thoughts.hardLimitBufferPercent
const originalContentLanguage = config.contentLanguage

beforeEach(createTestDb)
afterEach(() => {
  const { closeDb } = require('../db/init')
  closeDb()
  config.thoughts.softLimit = originalSoftLimit
  config.thoughts.hardLimitBufferPercent = originalHardLimitBufferPercent
  config.contentLanguage = originalContentLanguage
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
  expect(t.content_language).toBe(config.contentLanguage)
})

test('createThoughtWithParentService creates thought with parent edge', () => {
  const parentId = seedThought()
  const child = createThoughtWithParentService({ content: 'child' }, parentId, 'develops')
  const db = getDb()
  const edges = db
    .prepare('SELECT * FROM edges WHERE source_id = ? AND target_id = ?')
    .all(parentId, child.id)
  expect(edges).toHaveLength(1)
  expect((edges[0] as { type: string }).type).toBe('develops')
})

test('createThoughtWithParentService validates status', () => {
  expect(() => createThoughtWithParentService({ content: 'x', status: 'bogus' as any })).toThrow(
    ValidationError
  )
})

test('createThoughtWithParentService rejects content over hard limit', () => {
  const longContent = 'x'.repeat(100_001)
  expect(() => createThoughtWithParentService({ content: longContent })).toThrow(ValidationError)
})

test('createThoughtWithParentService stamps content_language from config', () => {
  config.contentLanguage = 'ru'
  const t = createThoughtWithParentService({ content: 'language probe' })
  expect(Object.hasOwn(t, 'content_language')).toBeTrue()
  expect(t.content_language).toBe('ru')
})

test('updateThoughtByIdService updates content', () => {
  const id = seedThought()
  const updated = updateThoughtByIdService(id, { content: 'updated' })
  expect(updated).not.toBeNull()
  expect(updated!.content).toBe('updated')
  expect(updated!.content_language).toBe(config.contentLanguage)
})

test('updateThoughtByIdService stamps content_language from config', () => {
  const id = seedThought()
  config.contentLanguage = 'ru'
  const updated = updateThoughtByIdService(id, { content: 'language probe' })
  expect(Object.hasOwn(updated!, 'content_language')).toBeTrue()
  expect(updated!.content_language).toBe('ru')
})

test('read paths do not own content_language', () => {
  config.contentLanguage = 'ru'
  const id = seedThought({ content: 'read probe' })

  const read = getThoughtByIdService(id)
  expect(Object.hasOwn(read!, 'content_language')).toBeFalse()
  expect(read!.content_language).toBeUndefined()

  const listed = listThoughtsPageService().thoughts.find(t => t.id === id)
  expect(listed).toBeDefined()
  expect(Object.hasOwn(listed!, 'content_language')).toBeFalse()
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

test('listThoughtsPageService returns thoughts with the page metadata', () => {
  seedThought({ content: 'first' })
  seedThought({ content: 'second' })
  const page = listThoughtsPageService()
  expect(page.thoughts.length).toBeGreaterThanOrEqual(2)
  expect(page.total).toBeGreaterThanOrEqual(2)
  expect(page.offset).toBe(0)
})

test('listThoughtsPageService filters by status', () => {
  seedThought({ content: 'active1', status: 'active' })
  seedThought({ content: 'draft1', status: 'draft' })
  const active = listThoughtsPageService({ status: 'active' })
  expect(active.thoughts.every(t => t.status === 'active')).toBeTrue()
})

test('mergeThoughtsService throws for same source and target', () => {
  const id = seedThought()
  expect(() => mergeThoughtsService({ targetId: id, sourceId: id })).toThrow(ValidationError)
})

test('mergeThoughtsService throws for missing source', () => {
  const target = seedThought()
  expect(() => mergeThoughtsService({ targetId: target, sourceId: 'nonexistent' })).toThrow(
    NotFoundError
  )
})

test('mergeThoughtsService throws for missing target', () => {
  const source = seedThought()
  expect(() => mergeThoughtsService({ targetId: 'nonexistent', sourceId: source })).toThrow(
    NotFoundError
  )
})

test('mergeThoughtsService throws for archived source', () => {
  const source = seedThought({ status: 'archived' })
  const target = seedThought()
  expect(() => mergeThoughtsService({ targetId: target, sourceId: source })).toThrow(
    ValidationError
  )
})

test('mergeThoughtsService merges content and transfers edges', () => {
  const source = seedThought({ content: 'source thought' })
  const target = seedThought({ content: 'target thought' })
  const third = seedThought()
  seedEdge(source, third, 'related')
  const result = mergeThoughtsService({
    targetId: target,
    sourceId: source,
    mergedContent: 'merged content',
    mergedTags: ['tag1']
  })
  expect(result.target.content).toBe('merged content')
  expect(result.transferredEdges).toBe(1)
  const srcAfter = getThoughtByIdService(source)
  expect(srcAfter!.status).toBe('archived')
  const db = getDb()
  const leftoverEdges = db.prepare('SELECT 1 FROM edges WHERE source_id = ?').all(source)
  expect(leftoverEdges).toHaveLength(0)
})

test('mergeThoughtsService handles preview mode (no content/tags)', () => {
  const source = seedThought({ content: 'source' })
  const target = seedThought({ content: 'target' })
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
  expect(() => validateContentLength('short', getThoughtLimitsDB())).not.toThrow()
})

test('createThoughtWithParentService accepts content exactly at the derived hard limit', () => {
  config.thoughts.softLimit = 10
  config.thoughts.hardLimitBufferPercent = 50
  const { hardLimit } = getThoughtLimitsDB()
  expect(hardLimit).toBe(15)

  const thought = createThoughtWithParentService({ content: 'x'.repeat(hardLimit) })
  expect(thought.content).toHaveLength(hardLimit)
})

test('createThoughtWithParentService rejects content one char over the derived hard limit', () => {
  config.thoughts.softLimit = 10
  config.thoughts.hardLimitBufferPercent = 50
  const { hardLimit } = getThoughtLimitsDB()

  expect(() => createThoughtWithParentService({ content: 'x'.repeat(hardLimit + 1) })).toThrow(
    ValidationError
  )
})

test('content between soft and hard limit is accepted (soft limit is advisory)', () => {
  config.thoughts.softLimit = 10
  config.thoughts.hardLimitBufferPercent = 50
  const { softLimit, hardLimit } = getThoughtLimitsDB()
  const middle = softLimit + 1
  expect(middle).toBeGreaterThan(softLimit)
  expect(middle).toBeLessThan(hardLimit)

  expect(() => createThoughtWithParentService({ content: 'x'.repeat(middle) })).not.toThrow()
})

test('updateThoughtByIdService enforces the derived hard limit and accepts the exact ceiling', () => {
  const id = seedThought({ content: 'short' })
  config.thoughts.softLimit = 10
  config.thoughts.hardLimitBufferPercent = 50
  const { hardLimit } = getThoughtLimitsDB()

  expect(() => updateThoughtByIdService(id, { content: 'x'.repeat(hardLimit + 1) })).toThrow(
    ValidationError
  )
  expect(updateThoughtByIdService(id, { content: 'x'.repeat(hardLimit) })?.content).toHaveLength(
    hardLimit
  )
})

test('updating onto live content throws the 409-class conflict and writes nothing', () => {
  const holder = createThoughtWithUrlLinksService({ content: 'content already in use' })
  const target = createThoughtWithUrlLinksService({ content: 'my own content' })

  for (let attempt = 0; attempt < 2; attempt += 1) {
    expect(() =>
      updateThoughtByIdService(target.id, { content: 'content already in use' })
    ).toThrow(ThoughtContentConflictError)
  }

  expect(getThoughtByIdService(target.id)?.content).toBe('my own content')
  expect(getThoughtByIdService(holder.id)?.content).toBe('content already in use')
})

test('re-activating a thought whose content is live again throws the conflict', () => {
  const archived = createThoughtWithUrlLinksService({ content: 'recycled content' })
  expect(archiveThoughtByIdService(archived.id)?.status).toBe('archived')
  const live = createThoughtWithUrlLinksService({ content: 'recycled content' })
  expect(live.id).not.toBe(archived.id)

  expect(() => updateThoughtByIdService(archived.id, { status: 'active' })).toThrow(
    ThoughtContentConflictError
  )
  expect(getThoughtByIdService(archived.id)?.status).toBe('archived')
})

test('an ordinary update, activation and archive still succeed', () => {
  const thought = createThoughtWithUrlLinksService({ content: 'ordinary content' })

  expect(updateThoughtByIdService(thought.id, { content: 'rewritten content' })?.content).toBe(
    'rewritten content'
  )
  expect(updateThoughtByIdService(thought.id, { status: 'active' })?.status).toBe('active')
  expect(archiveThoughtByIdService(thought.id)?.status).toBe('archived')
})

test('a duplicate parent edge is logged and skipped instead of failing the create', () => {
  const parentId = seedThought()
  const first = createThoughtWithParentService({ content: 'deduped child' }, parentId, 'parent')
  // The same content dedupes onto the same thought, so the parent edge is now a duplicate.
  const second = createThoughtWithParentService({ content: 'deduped child' }, parentId, 'parent')

  expect(second.id).toBe(first.id)
  const edges = getDb()
    .prepare(`SELECT type FROM edges WHERE source_id = ? AND target_id = ?`)
    .all(parentId, first.id) as { type: string }[]
  expect(edges).toEqual([{ type: 'parent' }])
})

test('surface_after rejects a value that is not an ISO timestamp and writes nothing', () => {
  const thought = createThoughtWithUrlLinksService({ content: 'scheduled' })

  for (const value of ['tomorrow', '2026-13-01T00:00:00.000Z', '2026-01-01']) {
    expect(() => updateThoughtByIdService(thought.id, { surface_after: value as string })).toThrow(
      ValidationError
    )
    expect(() => updateThoughtByIdService(thought.id, { surface_after: value as string })).toThrow(
      `Invalid surface_after: ${value}`
    )
  }
  expect(getThoughtByIdService(thought.id)?.surface_after).toBeNull()
})

test('surface_after accepts an ISO timestamp and can be cleared again', () => {
  const thought = createThoughtWithUrlLinksService({ content: 'scheduled' })
  const at = '2030-01-01T00:00:00.000Z'

  expect(updateThoughtByIdService(thought.id, { surface_after: at })?.surface_after).toBe(at)
  expect(updateThoughtByIdService(thought.id, { surface_after: null })?.surface_after).toBeNull()
})

test('archiveThoughtsBatchService archives each id and reports the missing ones', () => {
  const first = seedThought({ content: 'batch one' })
  const second = seedThought({ content: 'batch two' })
  const missing = '0195d0a4-0000-7000-8000-000000000000'

  const result = archiveThoughtsBatchService([first, second, missing])

  expect(result.archived).toBe(2)
  expect(result.failed).toBe(1)
  expect(result.errors).toEqual([{ thought_id: missing, error: `Thought '${missing}' not found` }])
  expect(getThoughtByIdService(first)?.status).toBe('archived')
  expect(getThoughtByIdService(second)?.status).toBe('archived')
})

test('archiveThoughtsBatchService counts an already-archived id without rewriting it', () => {
  const archived = seedThought({ content: 'already gone', status: 'archived' })

  const result = archiveThoughtsBatchService([archived])

  expect(result).toEqual({ archived: 1, failed: 0, errors: [] })
  expect(getThoughtByIdService(archived)?.status).toBe('archived')
})

test('archiveThoughtsBatchService refuses an empty or oversized batch', () => {
  expect(() => archiveThoughtsBatchService([])).toThrow(
    'thought_ids is required and must not be empty'
  )

  const tooMany = Array.from({ length: BATCH_ITEMS_MAX + 1 }, () => 'id')
  expect(() => archiveThoughtsBatchService(tooMany)).toThrow(
    `thought_ids accepts at most ${BATCH_ITEMS_MAX} ids per call (got ${tooMany.length})`
  )
})
