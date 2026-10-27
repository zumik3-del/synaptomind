import { afterEach, beforeEach, expect, test } from 'bun:test'
import { getDb } from '../db'
import { closeDb } from '../db/init'
import { createTestDb, seedThought } from '../test/helpers'
import { ValidationError } from '../errors'
import { getThoughtByIdService } from './thoughts.service'
import { bulkCreateThoughtsService } from './bulk.service'

// Bulk-create coverage moved off the deleted `POST /api/thoughts/bulk` route
// (ADR 2026-10-26): the MCP `memory_store action=bulk_create` is the only
// caller left, so the guards and the per-item error contract are pinned here at
// the service the tool actually invokes.

beforeEach(createTestDb)
afterEach(closeDb)

test('bulkCreateThoughtsService rejects an absent thoughts array', () => {
  expect(() => bulkCreateThoughtsService(undefined)).toThrow(ValidationError)
})

test('bulkCreateThoughtsService rejects an empty thoughts array', () => {
  expect(() => bulkCreateThoughtsService([])).toThrow(ValidationError)
})

test('bulkCreateThoughtsService rejects more than 10000 thoughts before writing any', () => {
  const items = Array.from({ length: 10_001 }, (_, i) => ({ content: `bulk ${i}` }))
  expect(() => bulkCreateThoughtsService(items)).toThrow(ValidationError)
  const count = getDb().prepare('SELECT COUNT(*) AS n FROM thoughts').get() as { n: number }
  // Only the table's seed rows can be there; the oversized batch wrote nothing.
  expect(count.n).toBe(0)
})

test('bulkCreateThoughtsService creates every valid item and reports its index', () => {
  const result = bulkCreateThoughtsService([
    { content: 'bulk one', tags: ['bulk-tag'] },
    { content: 'bulk two', status: 'draft' }
  ])

  expect(result.created.map(c => c.index)).toEqual([0, 1])
  expect(result.errors).toEqual([])
  expect(getThoughtByIdService(result.created[0].thought.id)?.content).toBe('bulk one')
  expect(getThoughtByIdService(result.created[1].thought.id)?.status).toBe('draft')
})

test('bulkCreateThoughtsService reports per-item failures without aborting the rest', () => {
  const result = bulkCreateThoughtsService([
    { content: 'kept item' },
    { content: 'bad status item', status: 'bogus' as never },
    { content: 'another kept item' }
  ])

  expect(result.created.map(c => c.index)).toEqual([0, 2])
  expect(result.errors).toHaveLength(1)
  expect(result.errors[0].index).toBe(1)
  expect(result.errors[0].error).toContain('Invalid status')
  expect(getThoughtByIdService(result.created[1].thought.id)?.content).toBe('another kept item')
})

test('bulkCreateThoughtsService applies the default project to items without one', () => {
  seedThought({ content: 'anchor', project_id: 'bulk-project' })
  const result = bulkCreateThoughtsService([{ content: 'inherits the default project' }], 'bulk-project')
  expect(result.errors).toEqual([])
  expect(getThoughtByIdService(result.created[0].thought.id)?.project_id).toBe('bulk-project')
})
