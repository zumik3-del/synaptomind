import { afterEach, beforeEach, expect, test } from 'bun:test'
import { closeDb } from '../db/init'
import { createTestDb, seedThought } from '../test/helpers'
import { getDb } from '../db/container'
import {
  MAX_ATTEMPTS,
  deleteFromQueue,
  findPendingEmbeddings,
  handleFailedItem,
  insertEmbedding,
  sweepOrphanedThoughts
} from './queue'

beforeEach(() => {
  createTestDb()
  // vec_thoughts is a vec0 virtual table — unavailable in :memory: databases.
  // Stub it as a plain table like the verify/health-check tests do.
  getDb().prepare('CREATE TABLE IF NOT EXISTS vec_thoughts (id TEXT PRIMARY KEY, embedding BLOB)').run()
})

afterEach(closeDb)

// seedThought's insert trigger already queues the thought — replace the row to
// pin an explicit created_at (deterministic ordering) and error state.
function enqueue(id: string, createdAt: string): void {
  getDb()
    .prepare('INSERT OR REPLACE INTO pending_embeddings (thought_id, created_at) VALUES (?, ?)')
    .run(id, createdAt)
}

function pendingRow(id: string): { attempts: number; is_error: number; last_error: string | null; error: string | null } {
  return getDb()
    .prepare('SELECT attempts, is_error, last_error, error FROM pending_embeddings WHERE thought_id = ?')
    .get(id) as { attempts: number; is_error: number; last_error: string | null; error: string | null }
}

test('findPendingEmbeddings returns non-error rows ordered by created_at', () => {
  const third = seedThought({ content: 'queued third' })
  const first = seedThought({ content: 'queued first' })
  const second = seedThought({ content: 'queued second' })
  enqueue(third, '2026-01-03T00:00:00.000Z')
  enqueue(first, '2026-01-01T00:00:00.000Z')
  enqueue(second, '2026-01-02T00:00:00.000Z')

  const pending = findPendingEmbeddings(10)

  expect(pending.map(p => p.id)).toEqual([first, second, third])
  expect(pending[0]).toMatchObject({ id: first, content: 'queued first' })
})

test('findPendingEmbeddings skips dead-lettered rows and respects the limit', () => {
  const a = seedThought({ content: 'a' })
  const dead = seedThought({ content: 'dead' })
  const b = seedThought({ content: 'b' })
  enqueue(a, '2026-01-01T00:00:00.000Z')
  enqueue(dead, '2026-01-02T00:00:00.000Z')
  enqueue(b, '2026-01-03T00:00:00.000Z')
  getDb().prepare('UPDATE pending_embeddings SET is_error = 1 WHERE thought_id = ?').run(dead)

  expect(findPendingEmbeddings(10).map(p => p.id)).toEqual([a, b])
  expect(findPendingEmbeddings(1).map(p => p.id)).toEqual([a])
})

test('sweepOrphanedThoughts returns only thoughts with no vec row and no pending row', () => {
  const db = getDb()
  const orphan = seedThought({ content: 'orphan' })
  const archived = seedThought({ content: 'archived', status: 'archived' })
  const embedded = seedThought({ content: 'already embedded' })
  // keeps the pending row its insert trigger created → excluded from the sweep
  seedThought({ content: 'already queued' })
  for (const id of [orphan, archived, embedded]) {
    // the insert trigger queued every seeded thought — clear non-orphans
    db.prepare('DELETE FROM pending_embeddings WHERE thought_id = ?').run(id)
  }
  db.prepare('INSERT INTO vec_thoughts (id, embedding) VALUES (?, ?)').run(embedded, Buffer.alloc(0))

  const swept = sweepOrphanedThoughts(10)

  expect(swept.map(s => s.id)).toEqual([orphan])
  expect(swept[0]?.content).toBe('orphan')
})

test('sweepOrphanedThoughts excludes archived thoughts (#113)', () => {
  const db = getDb()
  const archived = seedThought({ content: 'archived orphan', status: 'archived' })
  db.prepare('DELETE FROM pending_embeddings WHERE thought_id = ?').run(archived)

  expect(sweepOrphanedThoughts(10)).toEqual([])
})

test('sweepOrphanedThoughts respects the limit', () => {
  const db = getDb()
  const one = seedThought({ content: 'orphan one' })
  const two = seedThought({ content: 'orphan two' })
  for (const id of [one, two]) {
    db.prepare('DELETE FROM pending_embeddings WHERE thought_id = ?').run(id)
  }

  expect(sweepOrphanedThoughts(1).map(s => s.id)).toEqual([one])
  expect(sweepOrphanedThoughts(10).map(s => s.id)).toEqual([one, two])
})

test('handleFailedItem increments attempts and stays queued below MAX_ATTEMPTS', () => {
  const id = seedThought({ content: 'flaky' })

  for (let i = 0; i < MAX_ATTEMPTS - 1; i++) {
    handleFailedItem(id, `boom ${i}`)
  }

  const row = pendingRow(id)
  expect(row.attempts).toBe(MAX_ATTEMPTS - 1)
  expect(row.is_error).toBe(0)
  expect(row.error).toBeNull()
  expect(row.last_error).toBe(`boom ${MAX_ATTEMPTS - 2}`)
})

test(`handleFailedItem dead-letters on attempt ${MAX_ATTEMPTS}`, () => {
  const id = seedThought({ content: 'poison' })

  for (let i = 0; i < MAX_ATTEMPTS; i++) {
    handleFailedItem(id, 'boom')
  }

  const row = pendingRow(id)
  expect(row.attempts).toBe(MAX_ATTEMPTS)
  expect(row.is_error).toBe(1)
  expect(row.error).toBe('boom')
  expect(row.last_error).toBe('boom')

  // dead-lettered rows leave the work queue
  expect(findPendingEmbeddings(10).map(p => p.id)).not.toContain(id)
})

test('insertEmbedding rejects a stale hash and writes nothing', () => {
  const db = getDb()
  const id = seedThought({ content: 'changed mid-batch' })
  db.prepare('UPDATE thoughts SET content_hash = ? WHERE id = ?').run('hash-a', id)

  const ok = insertEmbedding(id, new Float32Array([1, 2, 3]), 'hash-b')

  expect(ok).toBeFalse()
  expect(db.prepare('SELECT 1 FROM vec_thoughts WHERE id = ?').get(id)).toBeNull()
})

test('insertEmbedding stores the payload bytes on hash match', () => {
  const db = getDb()
  const id = seedThought({ content: 'stable' })
  db.prepare('UPDATE thoughts SET content_hash = ? WHERE id = ?').run('hash-a', id)
  const payload = new Float32Array([1.5, -2.5, 3.25])

  const ok = insertEmbedding(id, payload, 'hash-a')

  expect(ok).toBeTrue()
  const row = db.prepare('SELECT embedding FROM vec_thoughts WHERE id = ?').get(id) as {
    embedding: Uint8Array
  }
  const floats = new Float32Array(row.embedding.buffer, row.embedding.byteOffset, row.embedding.byteLength / 4)
  expect(Array.from(floats)).toEqual([1.5, -2.5, 3.25])
})

test('insertEmbedding replaces an existing vec row instead of duplicating it', () => {
  const db = getDb()
  const id = seedThought({ content: 're-embedded' })
  db.prepare('UPDATE thoughts SET content_hash = ? WHERE id = ?').run('hash-a', id)

  insertEmbedding(id, new Float32Array([1, 1, 1]), 'hash-a')
  insertEmbedding(id, new Float32Array([2, 2, 2]), 'hash-a')

  const rows = db.prepare('SELECT embedding FROM vec_thoughts WHERE id = ?').all(id) as {
    embedding: Uint8Array
  }[]
  expect(rows).toHaveLength(1)
  const floats = new Float32Array(rows[0]!.embedding.buffer, rows[0]!.embedding.byteOffset, rows[0]!.embedding.byteLength / 4)
  expect(Array.from(floats)).toEqual([2, 2, 2])
})

test('deleteFromQueue removes only the given rows', () => {
  const keep = seedThought({ content: 'keep' })
  const drop = seedThought({ content: 'drop' })

  deleteFromQueue([drop])

  const remaining = getDb().prepare('SELECT thought_id FROM pending_embeddings').all() as {
    thought_id: string
  }[]
  expect(remaining.map(r => r.thought_id)).toContain(keep)
  expect(remaining.map(r => r.thought_id)).not.toContain(drop)
})

test('deleteFromQueue tolerates an empty id list', () => {
  expect(() => deleteFromQueue([])).not.toThrow()
})
