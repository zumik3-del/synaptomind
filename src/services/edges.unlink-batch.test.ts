import { beforeEach, describe, expect, test } from 'bun:test'
import { getDb } from '../db'
import { findEdge } from '../db/edges'
import { createTestDb, seedEdge, seedThought } from '../test/helpers'
import { deleteEdgesBatchService } from './edges.service'

beforeEach(createTestDb)

describe('unlink batch atomicity', () => {
  test('duplicate existing IDs do not delete any edge', () => {
    const db = getDb()
    const a = seedEdge(seedThought(), seedThought())
    const b = seedEdge(seedThought(), seedThought())
    const ids = [a, b, a]
    const result = deleteEdgesBatchService(ids, true, db)
    expect(result.results.map(item => item.status)).toEqual(['failed', 'failed', 'failed'])
    expect(result.errors.map(item => item.index)).toEqual([0, 1, 2])
    expect([result.total, result.deleted, result.preview, result.failed]).toEqual([3, 0, 0, 3])
    expect(ids.map(id => Boolean(findEdge(db, id)))).toEqual([true, true, true])
  })

  test('missing and duplicate IDs abort every occurrence without mutation', () => {
    const db = getDb()
    const a = seedEdge(seedThought(), seedThought())
    const b = seedEdge(seedThought(), seedThought())
    const ids = [a, 'missing', a, b]
    const result = deleteEdgesBatchService(ids, true, db)
    expect(result.results.map(item => [item.edge_id, item.status])).toEqual(
      ids.map(id => [id, 'failed'])
    )
    expect(result.errors.map(item => item.index)).toEqual([0, 1, 2, 3])
    expect(result.errors[1].error).toContain('Edge not found')
    expect([result.deleted, result.failed, result.total]).toEqual([0, 4, 4])
    expect([Boolean(findEdge(db, a)), Boolean(findEdge(db, b))]).toEqual([true, true])
  })

  test('unique confirmed IDs delete all requested edges', () => {
    const db = getDb()
    const a = seedEdge(seedThought(), seedThought())
    const b = seedEdge(seedThought(), seedThought())
    const result = deleteEdgesBatchService([a, b], true, db)
    expect(result.results.map(item => item.status)).toEqual(['deleted', 'deleted'])
    expect([result.deleted, result.failed, result.total]).toEqual([2, 0, 2])
    expect(result.errors).toEqual([])
    expect([Boolean(findEdge(db, a)), Boolean(findEdge(db, b))]).toEqual([false, false])
  })

  test('preview duplicates remain per-occurrence and never mutate', () => {
    const db = getDb()
    const a = seedEdge(seedThought(), seedThought())
    const result = deleteEdgesBatchService([a, a, 'missing'], false, db)
    expect(result.results.map(item => item.status)).toEqual(['preview', 'preview', 'failed'])
    expect(result.results.slice(0, 2).map(item => item.edge?.id)).toEqual([a, a])
    expect([result.preview, result.failed, result.deleted, result.total]).toEqual([2, 1, 0, 3])
    expect(result.errors.map(item => item.index)).toEqual([2])
    expect(Boolean(findEdge(db, a))).toBe(true)
  })
})

describe('unlink batch failure paths', () => {
  test('the aborted-missing message reports no deletion without claiming a rollback', () => {
    const db = getDb()
    const existing = seedEdge(seedThought(), seedThought())

    const result = deleteEdgesBatchService([existing, 'missing'], true, db)

    expect(result.errors.map(item => [item.index, item.error])).toEqual([
      [0, 'batch aborted: not all edge_ids exist (no edges deleted)'],
      [1, 'Edge not found: missing']
    ])
    expect(Boolean(findEdge(db, existing))).toBe(true)
  })

  test('a delete that fails mid-run rolls the whole unlink back', () => {
    const db = getDb()
    const first = seedEdge(seedThought(), seedThought())
    const second = seedEdge(seedThought(), seedThought())
    db.run(
      `CREATE TRIGGER probe_block_unlink BEFORE DELETE ON edges
       WHEN OLD.id = '${second}'
       BEGIN SELECT RAISE(ABORT, 'probe: unlink blocked'); END`
    )

    expect(() => deleteEdgesBatchService([first, second], true, db)).toThrow(
      'probe: unlink blocked'
    )

    expect([Boolean(findEdge(db, first)), Boolean(findEdge(db, second))]).toEqual([true, true])
  })
})
