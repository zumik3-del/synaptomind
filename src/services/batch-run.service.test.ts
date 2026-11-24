import { afterEach, beforeEach, expect, test } from 'bun:test'
import type { Database } from 'bun:sqlite'
import { getDb } from '../db'
import { closeDb } from '../db/init'
import { ValidationError } from '../errors'
import { createTestDb } from '../test/helpers'
import { runTolerantBatch } from './batch-run.service'
import { bulkCreateThoughtsService } from './bulk.service'
import { createEdgesBatchService } from './edges.service'
import { archiveThoughtsBatchService } from './thoughts.service'

beforeEach(createTestDb)
afterEach(closeDb)

interface ProbeError {
  item: string
  index: number
  message: string
}

interface ProbeOutcome {
  results: string[]
  errors: ProbeError[]
}

const PROBE = 'batch_run_probe'

function createProbeTable(db: Database): void {
  db.run(`CREATE TABLE ${PROBE} (label TEXT NOT NULL)`)
}

function probeLabels(db: Database): string[] {
  const rows = db.prepare(`SELECT label FROM ${PROBE} ORDER BY rowid`).all() as Array<{
    label: string
  }>
  return rows.map(row => row.label)
}

const probeErrorRow = ({ item, index, message }: ProbeError): ProbeError => ({
  item,
  index,
  message
})

function insertProbeLabel(d: Database, item: string, index: number): string {
  d.prepare(`INSERT INTO ${PROBE} (label) VALUES (?)`).run(item)
  return `${index}:${item}`
}

function runProbe(
  items: string[],
  failOn: (item: string, index: number) => boolean,
  onItem?: (item: string) => void
): ProbeOutcome {
  const db = getDb()
  createProbeTable(db)
  return runTolerantBatch<string, string, ProbeError>(
    db,
    items,
    (item, index, d) => {
      onItem?.(item)
      d.prepare(`INSERT INTO ${PROBE} (label) VALUES (?)`).run(item)
      if (failOn(item, index)) throw new Error(`probe: ${item} failed`)
      return `${index}:${item}`
    },
    probeErrorRow
  )
}

test('runTolerantBatch rolls back the failing item and commits its neighbours', () => {
  const out = runProbe(['a', 'b', 'c'], item => item === 'b')

  expect(out.results).toEqual(['0:a', '2:c'])
  expect(out.errors).toEqual([{ item: 'b', index: 1, message: 'probe: b failed' }])
  expect(out.results.length + out.errors.length).toBe(3)
  expect(probeLabels(getDb())).toEqual(['a', 'c'])
})

test('runTolerantBatch reports every failure with its original index, never a renumbered one', () => {
  const out = runProbe(['a', 'b', 'c', 'd'], item => item === 'b' || item === 'd')

  expect(out.results).toEqual(['0:a', '2:c'])
  expect(out.errors).toEqual([
    { item: 'b', index: 1, message: 'probe: b failed' },
    { item: 'd', index: 3, message: 'probe: d failed' }
  ])
  expect(probeLabels(getDb())).toEqual(['a', 'c'])
})

test('bulkCreateThoughtsService lands each failure in the caller error row with its true index', () => {
  getDb().run(
    `CREATE TRIGGER probe_block_item BEFORE INSERT ON thoughts
     WHEN NEW.content IN ('bad one', 'bad two')
     BEGIN SELECT RAISE(ABORT, 'probe: item blocked'); END`
  )

  const result = bulkCreateThoughtsService([
    { content: 'keep one' },
    { content: 'bad one' },
    { content: 'keep two' },
    { content: 'bad two' }
  ])

  expect(result.created.map(entry => entry.index)).toEqual([0, 2])
  expect(result.errors).toEqual([
    { index: 1, error: 'probe: item blocked' },
    { index: 3, error: 'probe: item blocked' }
  ])
  const contents = getDb().prepare('SELECT content FROM thoughts ORDER BY content').all() as Array<{
    content: string
  }>
  expect(contents.map(row => row.content)).toEqual(['keep one', 'keep two'])
})

test('runTolerantBatch rethrows a run-level RAISE(ROLLBACK) and commits nothing', () => {
  const db = getDb()
  createProbeTable(db)
  db.run(
    `CREATE TRIGGER probe_abort_run BEFORE INSERT ON ${PROBE}
     WHEN NEW.label = 'c'
     BEGIN SELECT RAISE(ROLLBACK, 'probe: run aborted'); END`
  )
  const seen: string[] = []

  expect(() =>
    runTolerantBatch<string, string, ProbeError>(
      db,
      ['a', 'b', 'c'],
      (item, index, d) => {
        seen.push(item)
        return insertProbeLabel(d, item, index)
      },
      probeErrorRow
    )
  ).toThrow('probe: run aborted')

  expect(seen).toEqual(['a', 'b', 'c'])
  expect(probeLabels(db)).toEqual([])
})

test('runTolerantBatch stops at an early run-level abort instead of autocommitting the rest', () => {
  const db = getDb()
  createProbeTable(db)
  db.run(
    `CREATE TRIGGER probe_abort_early BEFORE INSERT ON ${PROBE}
     WHEN NEW.label = 'a'
     BEGIN SELECT RAISE(ROLLBACK, 'probe: run aborted early'); END`
  )
  const seen: string[] = []

  expect(() =>
    runTolerantBatch<string, string, ProbeError>(
      db,
      ['a', 'b', 'c'],
      (item, index, d) => {
        seen.push(item)
        return insertProbeLabel(d, item, index)
      },
      probeErrorRow
    )
  ).toThrow('probe: run aborted early')

  expect(seen).toEqual(['a'])
  expect(probeLabels(db)).toEqual([])
})

test('runTolerantBatch normalises a non-Error throw into the error row message', () => {
  const db = getDb()
  createProbeTable(db)

  const out = runTolerantBatch<string, string, ProbeError>(
    db,
    ['only'],
    () => {
      throw 'bare string failure'
    },
    probeErrorRow
  )

  expect(out.results).toEqual([])
  expect(out.errors).toEqual([{ item: 'only', index: 0, message: 'bare string failure' }])
})

test('runTolerantBatch does not validate emptiness; each batch service keeps its own guard', () => {
  const db = getDb()
  createProbeTable(db)
  const seen: string[] = []

  const out = runTolerantBatch<string, string, ProbeError>(
    db,
    [],
    item => {
      seen.push(item)
      return item
    },
    probeErrorRow
  )
  expect(out).toEqual({ results: [], errors: [] })
  expect(seen).toEqual([])

  expect(() => bulkCreateThoughtsService([])).toThrow(ValidationError)
  expect(() => archiveThoughtsBatchService([])).toThrow(ValidationError)
  expect(() => createEdgesBatchService([])).toThrow(ValidationError)
})
