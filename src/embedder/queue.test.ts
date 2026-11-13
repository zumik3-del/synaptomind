import { afterEach, beforeEach, expect, test } from 'bun:test'
import { closeDb } from '../db/init'
import { createTestDb, seedThought } from '../test/helpers'
import { getDb } from '../context/container'
import {
  MAX_ATTEMPTS,
  deleteEmbeddedFromQueue,
  deleteFromQueue,
  findPendingEmbeddings,
  handleFailedItem,
  hasPendingEmbeddings,
  insertEmbedding,
  sweepOrphanedThoughts
} from '../db/pending-embeddings'

beforeEach(() => {
  createTestDb()
  // vec_thoughts is a vec0 virtual table — unavailable in :memory: databases.
  // Stub it as a plain table like the verify/health-check tests do.
  getDb()
    .prepare(
      'CREATE TABLE IF NOT EXISTS vec_thoughts (id TEXT PRIMARY KEY, embedding BLOB, scope TEXT)'
    )
    .run()
})

afterEach(closeDb)

// seedThought's insert trigger already queues the thought — replace the row to
// pin an explicit created_at (deterministic ordering) and error state.
function enqueue(id: string, createdAt: string): void {
  getDb()
    .prepare('INSERT OR REPLACE INTO pending_embeddings (thought_id, created_at) VALUES (?, ?)')
    .run(id, createdAt)
}

function pendingRow(id: string): {
  attempts: number
  is_error: number
  last_error: string | null
  error: string | null
} {
  return getDb()
    .prepare(
      'SELECT attempts, is_error, last_error, error FROM pending_embeddings WHERE thought_id = ?'
    )
    .get(id) as {
    attempts: number
    is_error: number
    last_error: string | null
    error: string | null
  }
}

test('findPendingEmbeddings returns non-error rows ordered by created_at', () => {
  const db = getDb()
  const third = seedThought({ content: 'queued third' })
  const first = seedThought({ content: 'queued first' })
  const second = seedThought({ content: 'queued second' })
  enqueue(third, '2026-01-03T00:00:00.000Z')
  enqueue(first, '2026-01-01T00:00:00.000Z')
  enqueue(second, '2026-01-02T00:00:00.000Z')

  const pending = findPendingEmbeddings(db, 10)

  expect(pending.map(p => p.id)).toEqual([first, second, third])
  expect(pending[0]).toMatchObject({ id: first, content: 'queued first' })
})

test('findPendingEmbeddings skips dead-lettered rows and respects the limit', () => {
  const db = getDb()
  const a = seedThought({ content: 'a' })
  const dead = seedThought({ content: 'dead' })
  const b = seedThought({ content: 'b' })
  enqueue(a, '2026-01-01T00:00:00.000Z')
  enqueue(dead, '2026-01-02T00:00:00.000Z')
  enqueue(b, '2026-01-03T00:00:00.000Z')
  getDb().prepare('UPDATE pending_embeddings SET is_error = 1 WHERE thought_id = ?').run(dead)

  expect(findPendingEmbeddings(db, 10).map(p => p.id)).toEqual([a, b])
  expect(findPendingEmbeddings(db, 1).map(p => p.id)).toEqual([a])
})

test('hasPendingEmbeddings is true only while a retryable row is queued (#2468)', () => {
  const db = getDb()
  const live = seedThought({ content: 'live' })
  const dead = seedThought({ content: 'dead letter' })
  enqueue(live, '2026-01-01T00:00:00.000Z')
  enqueue(dead, '2026-01-02T00:00:00.000Z')
  getDb().prepare('UPDATE pending_embeddings SET is_error = 1 WHERE thought_id = ?').run(dead)

  expect(hasPendingEmbeddings(db)).toBe(true)

  // Dead letters leave the poll loop until an opt-in reset, so a poison row must
  // not keep the orphan sweep disabled — the tick guard is about real work.
  db.prepare('DELETE FROM pending_embeddings WHERE thought_id = ?').run(live)
  expect(hasPendingEmbeddings(db)).toBe(false)

  db.prepare('DELETE FROM pending_embeddings').run()
  expect(hasPendingEmbeddings(db)).toBe(false)
})

test('sweepOrphanedThoughts returns only thoughts with no vec row and no pending row', () => {
  const db = getDb()
  const orphan = seedThought({ content: 'orphan' })
  const archived = seedThought({ content: 'archived', status: 'archived' })
  const embedded = seedThought({ content: 'already embedded' })
  seedThought({ content: 'already queued' })
  for (const id of [orphan, archived, embedded]) {
    db.prepare('DELETE FROM pending_embeddings WHERE thought_id = ?').run(id)
  }
  db.prepare(`INSERT INTO vec_thoughts (id, embedding, scope) VALUES (?, ?, 'default')`).run(
    embedded,
    Buffer.alloc(0)
  )

  const swept = sweepOrphanedThoughts(db, 10)

  expect(swept.map(s => s.id)).toEqual([orphan])
  expect(swept[0]?.content).toBe('orphan')
})

test('sweepOrphanedThoughts excludes archived thoughts (#113)', () => {
  const db = getDb()
  const archived = seedThought({ content: 'archived orphan', status: 'archived' })
  db.prepare('DELETE FROM pending_embeddings WHERE thought_id = ?').run(archived)

  expect(sweepOrphanedThoughts(db, 10)).toEqual([])
})

test('sweepOrphanedThoughts respects the limit', () => {
  const db = getDb()
  const one = seedThought({ content: 'orphan one' })
  const two = seedThought({ content: 'orphan two' })
  for (const id of [one, two]) {
    db.prepare('DELETE FROM pending_embeddings WHERE thought_id = ?').run(id)
  }

  expect(sweepOrphanedThoughts(db, 1).map(s => s.id)).toEqual([one])
  expect(sweepOrphanedThoughts(db, 10).map(s => s.id)).toEqual([one, two])
})

test('handleFailedItem increments attempts and stays queued below MAX_ATTEMPTS', () => {
  const db = getDb()
  const id = seedThought({ content: 'flaky' })

  for (let i = 0; i < MAX_ATTEMPTS - 1; i++) {
    handleFailedItem(db, id, `boom ${i}`)
  }

  const row = pendingRow(id)
  expect(row.attempts).toBe(MAX_ATTEMPTS - 1)
  expect(row.is_error).toBe(0)
  expect(row.error).toBeNull()
  expect(row.last_error).toBe(`boom ${MAX_ATTEMPTS - 2}`)
})

test(`handleFailedItem dead-letters on attempt ${MAX_ATTEMPTS}`, () => {
  const db = getDb()
  const id = seedThought({ content: 'poison' })

  for (let i = 0; i < MAX_ATTEMPTS; i++) {
    handleFailedItem(db, id, 'boom')
  }

  const row = pendingRow(id)
  expect(row.attempts).toBe(MAX_ATTEMPTS)
  expect(row.is_error).toBe(1)
  expect(row.error).toBe('boom')
  expect(row.last_error).toBe('boom')

  expect(findPendingEmbeddings(db, 10).map(p => p.id)).not.toContain(id)
})

test('insertEmbedding rejects a stale hash and writes nothing', () => {
  const db = getDb()
  const id = seedThought({ content: 'changed mid-batch' })
  db.prepare('UPDATE thoughts SET content_hash = ? WHERE id = ?').run('hash-a', id)

  const ok = insertEmbedding(db, id, new Float32Array([1, 2, 3]), 'hash-b')

  expect(ok).toBeFalse()
  expect(db.prepare('SELECT 1 FROM vec_thoughts WHERE id = ?').get(id)).toBeNull()
})

test('insertEmbedding stores the payload bytes on hash match', () => {
  const db = getDb()
  const id = seedThought({ content: 'stable' })
  db.prepare('UPDATE thoughts SET content_hash = ? WHERE id = ?').run('hash-a', id)
  const payload = new Float32Array([1.5, -2.5, 3.25])

  const ok = insertEmbedding(db, id, payload, 'hash-a')

  expect(ok).toBeTrue()
  const row = db.prepare('SELECT embedding FROM vec_thoughts WHERE id = ?').get(id) as {
    embedding: Uint8Array
  }
  const floats = new Float32Array(
    row.embedding.buffer,
    row.embedding.byteOffset,
    row.embedding.byteLength / 4
  )
  expect(Array.from(floats)).toEqual([1.5, -2.5, 3.25])
})

test('insertEmbedding replaces an existing vec row instead of duplicating it', () => {
  const db = getDb()
  const id = seedThought({ content: 're-embedded' })
  db.prepare('UPDATE thoughts SET content_hash = ? WHERE id = ?').run('hash-a', id)

  insertEmbedding(db, id, new Float32Array([1, 1, 1]), 'hash-a')
  insertEmbedding(db, id, new Float32Array([2, 2, 2]), 'hash-a')

  const rows = db.prepare('SELECT embedding FROM vec_thoughts WHERE id = ?').all(id) as {
    embedding: Uint8Array
  }[]
  expect(rows).toHaveLength(1)
  const floats = new Float32Array(
    rows[0]!.embedding.buffer,
    rows[0]!.embedding.byteOffset,
    rows[0]!.embedding.byteLength / 4
  )
  expect(Array.from(floats)).toEqual([2, 2, 2])
})

test('deleteFromQueue removes only the given rows', () => {
  const db = getDb()
  const keep = seedThought({ content: 'keep' })
  const drop = seedThought({ content: 'drop' })

  deleteFromQueue(db, [drop])

  const remaining = db.prepare('SELECT thought_id FROM pending_embeddings').all() as {
    thought_id: string
  }[]
  expect(remaining.map(r => r.thought_id)).toContain(keep)
  expect(remaining.map(r => r.thought_id)).not.toContain(drop)
})

test('deleteFromQueue tolerates an empty id list', () => {
  expect(() => deleteFromQueue(getDb(), [])).not.toThrow()
})

function setContent(id: string, content: string, contentHash: string): void {
  getDb()
    .prepare('UPDATE thoughts SET content = ?, content_hash = ? WHERE id = ?')
    .run(content, contentHash, id)
}

function queued(id: string): boolean {
  return getDb().prepare('SELECT 1 FROM pending_embeddings WHERE thought_id = ?').get(id) !== null
}

test('deleteEmbeddedFromQueue retires a row whose content hash still matches', () => {
  const db = getDb()
  const id = seedThought({ content: 'stable' })
  setContent(id, 'stable', 'hash-a')

  deleteEmbeddedFromQueue(db, [{ id, contentHash: 'hash-a' }])

  expect(queued(id)).toBeFalse()
})

test('deleteEmbeddedFromQueue keeps a row whose content already changed, so the next poll re-embeds it', () => {
  const db = getDb()
  const id = seedThought({ content: 'old' })
  // The batch read the row at hash-old; the trigger has since replaced the queue
  // row under hash-new. Retiring by id alone would drop that fresh row forever.
  setContent(id, 'new', 'hash-new')

  deleteEmbeddedFromQueue(db, [{ id, contentHash: 'hash-old' }])

  expect(queued(id)).toBeTrue()
  expect(findPendingEmbeddings(db, 10)).toContainEqual({
    id,
    content: 'new',
    contentHash: 'hash-new'
  })
})

test('deleteEmbeddedFromQueue judges every row on its own hash', () => {
  const db = getDb()
  const fresh = seedThought({ content: 'fresh' })
  const stale = seedThought({ content: 'stale' })
  // Distinct hashes: the v046 content-dedupe index forbids two live thoughts
  // sharing one (content_hash, project) pair.
  setContent(fresh, 'fresh', 'hash-fresh')
  setContent(stale, 'stale', 'hash-stale')

  deleteEmbeddedFromQueue(db, [
    { id: fresh, contentHash: 'hash-fresh' },
    { id: stale, contentHash: 'hash-batch-read' }
  ])

  expect(queued(fresh)).toBeFalse()
  expect(queued(stale)).toBeTrue()
})

test('deleteEmbeddedFromQueue tolerates an empty row list', () => {
  expect(() => deleteEmbeddedFromQueue(getDb(), [])).not.toThrow()
})
