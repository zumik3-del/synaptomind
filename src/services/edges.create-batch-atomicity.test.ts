import { afterEach, beforeEach, expect, test } from 'bun:test'
import { getDb } from '../context/container'
import { closeDb } from '../db/init'
import { createTestDb, seedThought } from '../test/helpers'
import { createEdgesBatchService } from './edges.service'

beforeEach(createTestDb)
afterEach(closeDb)

function edgesBetween(source: string, target: string): number {
  const row = getDb()
    .prepare('SELECT COUNT(*) AS n FROM edges WHERE source_id = ? AND target_id = ?')
    .get(source, target) as { n: number }
  return row.n
}

test('a constraint failure on one link leaves its neighbours committed and reports its index', () => {
  const [a, b, c, d] = ['a', 'b', 'c', 'd'].map(name => seedThought({ content: `${name} content` }))
  getDb().run(
    `CREATE TRIGGER probe_block_link BEFORE INSERT ON edges
     WHEN NEW.source_id = '${b}'
     BEGIN SELECT RAISE(ABORT, 'probe: link blocked'); END`
  )

  const result = createEdgesBatchService([
    { source: a, target: b },
    { source: b, target: c },
    { source: c, target: d }
  ])

  expect(result.linked).toBe(2)
  expect(result.failed).toBe(1)
  expect(result.errors).toEqual([{ index: 1, source: b, target: c, error: 'probe: link blocked' }])
  expect(edgesBetween(a, b)).toBe(1)
  expect(edgesBetween(b, c)).toBe(0)
  expect(edgesBetween(c, d)).toBe(1)
})

test('a run-level abort discards every link of the run', () => {
  const [a, b, c, d] = ['a', 'b', 'c', 'd'].map(name => seedThought({ content: `${name} content` }))
  getDb().run(
    `CREATE TRIGGER probe_abort_run BEFORE INSERT ON edges
     WHEN NEW.source_id = '${c}'
     BEGIN SELECT RAISE(ROLLBACK, 'probe: run aborted'); END`
  )

  expect(() =>
    createEdgesBatchService([
      { source: a, target: b },
      { source: b, target: c },
      { source: c, target: d }
    ])
  ).toThrow()

  const edges = getDb().prepare('SELECT COUNT(*) AS n FROM edges').get() as { n: number }
  expect(edges.n).toBe(0)
})
