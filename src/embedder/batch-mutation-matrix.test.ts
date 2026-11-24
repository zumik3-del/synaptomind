import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { getDb } from '../db'
import { closeDb } from '../db/init'
import { classifyBatch } from './batch'
import { createTestDb, seedThought } from '../test/helpers'
import { MAX_ATTEMPTS, CONTENT_CHANGED_REASON, handleFailedItem } from '../db/pending-embeddings'

beforeEach(() => {
  createTestDb()
  getDb()
    .prepare(
      'CREATE TABLE IF NOT EXISTS vec_thoughts (id TEXT PRIMARY KEY, embedding BLOB, scope TEXT)'
    )
    .run()
})

afterEach(closeDb)

function pendingRow(id: string): { attempts: number; is_error: number } {
  return getDb()
    .prepare('SELECT attempts, is_error FROM pending_embeddings WHERE thought_id = ?')
    .get(id) as { attempts: number; is_error: number }
}

function setAttempts(id: string, n: number): void {
  getDb().prepare('UPDATE pending_embeddings SET attempts = ? WHERE thought_id = ?').run(n, id)
}

describe('mutation matrix: handleFailedItem outcomes x attempts-before', () => {
  for (const before of [0, MAX_ATTEMPTS - 2, MAX_ATTEMPTS - 1]) {
    test(`fail: attempts before=${before} -> attempts=${before + 1}`, () => {
      const id = seedThought({ content: 'flaky' })
      setAttempts(id, before)
      handleFailedItem(getDb(), id, 'boom')

      const row = pendingRow(id)
      expect(row.attempts).toBe(before + 1)
      expect(row.is_error).toBe(before + 1 >= MAX_ATTEMPTS ? 1 : 0)
    })
  }

  for (const before of [0, MAX_ATTEMPTS - 2, MAX_ATTEMPTS - 1]) {
    test(`skip: attempts before=${before} -> attempts=${before + 1}`, () => {
      const id = seedThought({ content: 'changed' })
      setAttempts(id, before)
      handleFailedItem(getDb(), id, CONTENT_CHANGED_REASON)

      const row = pendingRow(id)
      expect(row.attempts).toBe(before + 1)
      expect(row.is_error).toBe(before + 1 >= MAX_ATTEMPTS ? 1 : 0)
    })
  }
})

describe('backoff isolation (skipped rows do not advance failure counter)', () => {
  test('a skipped outcome yields consecutiveFailures reset to 0, not +1', () => {
    const nextFailures = (failed: number, total: number, current: number): number =>
      failed === total ? current + 1 : 0
    expect(nextFailures(0, 3, 4)).toBe(0)
    expect(nextFailures(3, 3, 4)).toBe(5)
    expect(nextFailures(1, 3, 4)).toBe(0)
  })

  test('a skipped row stays queued with is_error=0 after a single skip (not dead-lettered)', () => {
    const id = seedThought({ content: 'changed mid-batch' })
    handleFailedItem(getDb(), id, CONTENT_CHANGED_REASON)
    const row = pendingRow(id)
    expect(row.is_error).toBe(0)
    expect(row.attempts).toBe(1)
  })
})

describe('only-succeeded-licenses-delete invariant', () => {
  test('a skipped row is never retired (stays queued for retry)', () => {
    const db = getDb()
    const skippedId = seedThought({ content: 'old' })
    const succeededId = seedThought({ content: 'stable' })
    db.prepare('DELETE FROM pending_embeddings WHERE thought_id = ?').run(succeededId)
    handleFailedItem(db, skippedId, CONTENT_CHANGED_REASON)

    expect(
      db.prepare('SELECT 1 FROM pending_embeddings WHERE thought_id = ?').get(succeededId)
    ).toBeNull()
    const skipped = db
      .prepare('SELECT attempts, is_error FROM pending_embeddings WHERE thought_id = ?')
      .get(skippedId) as { attempts: number; is_error: number } | undefined
    expect(skipped).toBeDefined()
    expect(skipped!.is_error).toBe(0)
  })
})

describe('classifyBatch guard: skipped is not succeeded', () => {
  test('a skipped row lands in contentChanged, never in succeeded', () => {
    const outcome = classifyBatch([{ id: 'a', content: 'A', contentHash: 'h' }], () => 'skipped')
    expect(outcome.succeeded).toEqual([])
    expect(outcome.contentChanged).toEqual(['a'])
  })

  test('a failed row lands in failed, never in succeeded', () => {
    const outcome = classifyBatch([{ id: 'a', content: 'A', contentHash: 'h' }], () => ({
      id: 'a',
      error: 'boom'
    }))
    expect(outcome.succeeded).toEqual([])
    expect(outcome.failed).toEqual([{ id: 'a', error: 'boom' }])
  })
})
