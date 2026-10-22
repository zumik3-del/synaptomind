import { afterEach, beforeEach, expect, test } from 'bun:test'
import { getDb } from '../db'
import { closeDb } from '../db/init'
import { createTestDb, seedEdge, seedThought } from '../test/helpers'
import { getBoundedMergePreviewService, getMergePreviewService } from './merge.service'

beforeEach(createTestDb)
afterEach(closeDb)

test('bounded merge preview retrieves an ordered SQL-limited edge page and full count', () => {
  const source = seedThought({ content: 'high-degree source' })
  const target = seedThought({ content: 'merge target' })
  const edgeIds: string[] = []
  for (let i = 0; i < 160; i++) {
    const neighbor = seedThought({ content: `neighbor ${i}` })
    edgeIds.push(seedEdge(source, neighbor, 'develops'))
  }

  const limit = 7
  const preview = getBoundedMergePreviewService(source, target, limit, getDb())!

  expect(preview.source.edges.map(edge => edge.id)).toEqual(edgeIds.sort().slice(0, limit))
  expect(preview.source.edges).toHaveLength(limit)
  expect(preview.sourceEdgeCount).toBe(160)

  // The HTTP caller intentionally retains its existing unbounded preview contract.
  expect(getMergePreviewService(source, target, getDb())?.source.edges).toHaveLength(160)
})
