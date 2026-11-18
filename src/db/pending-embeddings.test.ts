import { afterEach, beforeEach, expect, test } from 'bun:test'
import { getDb } from '../context/container'
import { closeDb } from './init'
import { createTestDb, seedThought } from '../test/helpers'
import { requeueEmbeddings } from './pending-embeddings'

beforeEach(createTestDb)
afterEach(closeDb)

interface QueueRow {
  thought_id: string
  attempts: number
  is_error: number
  error: string | null
}

function queueRow(id: string): QueueRow | null {
  return getDb()
    .prepare(
      `SELECT thought_id, attempts, is_error, error FROM pending_embeddings WHERE thought_id = ?`
    )
    .get(id) as QueueRow | null
}

test('requeueEmbeddings queues every thought that has no queue row yet', () => {
  const first = seedThought({ content: 'queued one' })
  const second = seedThought({ content: 'queued two' })
  getDb().prepare(`DELETE FROM pending_embeddings`).run()
  expect(queueRow(first)).toBeNull()

  requeueEmbeddings(getDb(), [first, second])

  expect(queueRow(first)).toMatchObject({ thought_id: first, attempts: 0, is_error: 0 })
  expect(queueRow(second)).toMatchObject({ thought_id: second, attempts: 0, is_error: 0 })
})

test('requeueEmbeddings never resets the attempts or the dead letter of an existing row', () => {
  const id = seedThought({ content: 'dead letter' })
  getDb()
    .prepare(
      `UPDATE pending_embeddings SET attempts = 9, is_error = 1, error = 'boom' WHERE thought_id = ?`
    )
    .run(id)

  requeueEmbeddings(getDb(), [id])

  expect(queueRow(id)).toEqual({ thought_id: id, attempts: 9, is_error: 1, error: 'boom' })
})

test('requeueEmbeddings of no ids writes nothing', () => {
  const before = getDb().prepare(`SELECT COUNT(*) AS n FROM pending_embeddings`).get() as {
    n: number
  }

  requeueEmbeddings(getDb(), [])

  const after = getDb().prepare(`SELECT COUNT(*) AS n FROM pending_embeddings`).get() as {
    n: number
  }
  expect(after.n).toBe(before.n)
})
