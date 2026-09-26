import { afterEach, beforeEach, expect, test } from 'bun:test'
import { createTestDb } from '../test/helpers'
import { getDb } from './container'
import { closeDb } from './init'
import { recordJobRun, getLastJobRun } from './meta'

beforeEach(createTestDb)
afterEach(closeDb)

test('recordJobRun stores run timestamp and result', () => {
  const db = getDb()
  recordJobRun(db, 'test_job', { items: 5, clusters: 2 })
  const { last_run, result } = getLastJobRun(db, 'test_job')
  expect(last_run).toBeString()
  expect(result).toEqual({ items: 5, clusters: 2 })
})

test('getLastJobRun returns nulls before any run', () => {
  const db = getDb()
  const { last_run, result } = getLastJobRun(db, 'nonexistent')
  expect(last_run).toBeNull()
  expect(result).toBeNull()
})

test('recordJobRun overwrites previous run', () => {
  const db = getDb()
  recordJobRun(db, 'overwrite', { step: 1 })
  recordJobRun(db, 'overwrite', { step: 2 })
  const { result } = getLastJobRun(db, 'overwrite')
  expect(result).toEqual({ step: 2 })
})

test('recordJobRun handles serializable result types', () => {
  const db = getDb()
  recordJobRun(db, 'string-result', 'done')
  recordJobRun(db, 'num-result', 42)
  recordJobRun(db, 'bool-result', true)
  expect((getLastJobRun(db, 'string-result').result as string | null)).toBe('done')
  expect((getLastJobRun(db, 'num-result').result as number | null)).toBe(42)
  expect((getLastJobRun(db, 'bool-result').result as boolean | null)).toBe(true)
})

test('getLastJobRun with typed generic preserves shape', () => {
  const db = getDb()
  recordJobRun(db, 'typed', { ok: true, count: 7 })
  const r = getLastJobRun<{ ok: boolean; count: number }>(db, 'typed')
  expect(r.result).toEqual({ ok: true, count: 7 })
})
