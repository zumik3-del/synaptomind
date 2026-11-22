import { afterEach, beforeEach, expect, test } from 'bun:test'
import { getDb } from '../db'
import { closeDb } from '../db/init'
import { createTestDb, seedThought } from '../test/helpers'
import { ValidationError } from '../errors'
import { getThoughtByIdService } from './thoughts.service'
import { bulkCreateThoughtsService } from './bulk.service'

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

test('bulkCreateThoughtsService isolates a constraint failure to its own item', () => {
  getDb().run(
    `CREATE TRIGGER probe_block_item BEFORE INSERT ON thoughts
     WHEN NEW.content = 'poison item'
     BEGIN SELECT RAISE(ABORT, 'probe: item blocked'); END`
  )

  const result = bulkCreateThoughtsService([
    { content: 'first good item' },
    { content: 'poison item' },
    { content: 'third good item' }
  ])

  expect(result.created.map(c => c.index)).toEqual([0, 2])
  expect(result.errors).toEqual([{ index: 1, error: 'probe: item blocked' }])
  const contents = getDb().prepare('SELECT content FROM thoughts ORDER BY content').all() as Array<{
    content: string
  }>
  expect(contents.map(row => row.content)).toEqual(['first good item', 'third good item'])
})

test('bulkCreateThoughtsService discards every item when the run aborts', () => {
  getDb().run(
    `CREATE TRIGGER probe_abort_run BEFORE INSERT ON thoughts
     WHEN NEW.content = 'last item'
     BEGIN SELECT RAISE(ROLLBACK, 'probe: run aborted'); END`
  )

  expect(() =>
    bulkCreateThoughtsService([
      { content: 'first good item' },
      { content: 'second good item' },
      { content: 'last item' }
    ])
  ).toThrow()

  const count = getDb().prepare('SELECT COUNT(*) AS n FROM thoughts').get() as { n: number }
  expect(count.n).toBe(0)
})

test('bulkCreateThoughtsService applies the default project to items without one', () => {
  seedThought({ content: 'anchor', project_id: 'bulk-project' })
  const result = bulkCreateThoughtsService(
    [{ content: 'inherits the default project' }],
    'bulk-project'
  )
  expect(result.errors).toEqual([])
  expect(getThoughtByIdService(result.created[0].thought.id)?.project_id).toBe('bulk-project')
})
