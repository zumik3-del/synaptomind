import { afterEach, beforeEach, expect, test } from 'bun:test'
import { getDb } from '../context/container'
import { closeDb } from '../db/init'
import { ValidationError } from '../errors'
import { BATCH_ITEMS_MAX } from '../validation'
import { createTestDb, seedEdge, seedThought } from '../test/helpers'
import {
  createEdgeService,
  createEdgesBatchService,
  deleteEdgesBatchService
} from './edges.service'

beforeEach(createTestDb)
afterEach(closeDb)

function tooMany<T>(make: (index: number) => T): T[] {
  return Array.from({ length: BATCH_ITEMS_MAX + 1 }, (_, index) => make(index))
}

test('createEdgeService requires a target, so a one-ended link is refused', () => {
  const source = seedThought()

  expect(() => createEdgeService(source, '')).toThrow(ValidationError)
  expect(() => createEdgeService(source, '')).toThrow('target_id is required')
})

test('createEdgeService returns the created edge for a valid pair', () => {
  const source = seedThought()
  const target = seedThought()

  const edge = createEdgeService(source, target, 'develops')

  expect(edge.source_id).toBe(source)
  expect(edge.target_id).toBe(target)
  expect(edge.type).toBe('develops')
})

test('link_batch refuses an empty list and one over the advertised bound', () => {
  expect(() => createEdgesBatchService([])).toThrow('links is required and must not be empty')

  const links = tooMany(index => ({ source: `s-${index}`, target: `t-${index}` }))
  expect(() => createEdgesBatchService(links)).toThrow(
    `links accepts at most ${BATCH_ITEMS_MAX} items per call (got ${links.length})`
  )
})

test('link_batch reports each bad item by index and still applies the good ones', () => {
  const a = seedThought()
  const b = seedThought()
  const c = seedThought()

  const result = createEdgesBatchService([
    { source: a, target: b, type: 'develops' },
    { source: '', target: c },
    { source: c, target: '', type: 'develops' },
    { source: c, target: c, type: 'develops' },
    { source: b, target: c, type: 'frobnicates' }
  ])

  expect(result.linked).toBe(1)
  expect(result.failed).toBe(4)
  expect(result.errors.map(error => error.index)).toEqual([1, 2, 3, 4])
  expect(result.errors[0].error).toBe('source is required')
  expect(result.errors[1].error).toBe('target is required')
  expect(result.errors[2].error).toContain('cannot link a thought to itself')
  expect(result.errors[3].error).toContain("Invalid edge type 'frobnicates'")
  expect(result.errors[3]).toMatchObject({ source: b, target: c })
})

test('unlink_batch refuses an empty list and one over the advertised bound', () => {
  expect(() => deleteEdgesBatchService([])).toThrow('edge_ids is required and must not be empty')

  const ids = tooMany(index => `edge-${index}`)
  expect(() => deleteEdgesBatchService(ids)).toThrow(
    `edge_ids accepts at most ${BATCH_ITEMS_MAX} items per call (got ${ids.length})`
  )
})

test('an unconfirmed unlink only previews, and the instruction names the confirming call', () => {
  const source = seedThought()
  const target = seedThought()
  const edgeId = seedEdge(source, target, 'develops')

  const result = deleteEdgesBatchService([edgeId], false)

  expect([result.preview, result.deleted, result.failed]).toEqual([1, 0, 0])
  expect(result.results[0].status).toBe('preview')
  expect(result.results[0].consequence).toContain("Removes the 'develops' edge")
  expect(result.instruction).toContain('confirm=true')
  expect(getDb().prepare(`SELECT 1 FROM edges WHERE id = ?`).get(edgeId)).not.toBeNull()
})
