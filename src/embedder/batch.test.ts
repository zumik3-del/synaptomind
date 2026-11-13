import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { getDb } from '../context/container'
import { closeDb } from '../db/init'
import { resolveCandidateEmbeddings } from '../services/candidate-embeddings.service'
import { createTestDb, seedThought } from '../test/helpers'
import {
  type BatchOutcome,
  type EmbeddingRow,
  type FailedRow,
  type RowOutcome,
  classifyBatch
} from './batch'
import {
  CONTENT_CHANGED_REASON,
  deleteEmbeddedFromQueue,
  deleteFromQueue,
  findPendingEmbeddings,
  handleFailedItem,
  insertEmbedding
} from '../db/pending-embeddings'

beforeEach(() => {
  createTestDb()
  // vec_thoughts is a vec0 virtual table — v002 skips it on `:memory:` databases,
  // so stub it as a plain table (same approach as queue.test.ts).
  getDb()
    .prepare(
      'CREATE TABLE IF NOT EXISTS vec_thoughts (id TEXT PRIMARY KEY, embedding BLOB, scope TEXT)'
    )
    .run()
})

afterEach(closeDb)

function row(id: string, content: string, contentHash: string): EmbeddingRow {
  return { id, content, contentHash }
}

function storeRowMirror(store: () => RowOutcome, id: string): RowOutcome | FailedRow {
  try {
    return store()
  } catch (err) {
    return { id, error: err instanceof Error ? err.message : String(err) }
  }
}

describe('classifyBatch contract (pure — no DB, no embedder child)', () => {
  const rows = [row('a', 'A', 'h1'), row('b', 'B', 'h2'), row('c', 'C', 'h3')]

  test("a 'stored' row lands in succeeded and nowhere else", () => {
    const outcome = classifyBatch(rows.slice(0, 1), () => 'stored')

    expect(outcome.succeeded).toEqual(['a'])
    expect(outcome.contentChanged).toEqual([])
    expect(outcome.failed).toEqual([])
  })

  test("a 'skipped' row lands in contentChanged and NOT in succeeded", () => {
    const outcome = classifyBatch(rows.slice(0, 1), () => 'skipped')

    expect(outcome.contentChanged).toEqual(['a'])
    expect(outcome.succeeded).toEqual([])
    expect(outcome.failed).toEqual([])
  })

  test('a thrown store lands in failed carrying its message', () => {
    const outcome = classifyBatch(rows.slice(0, 1), r =>
      storeRowMirror(() => {
        throw new Error(`boom ${r.id}`)
      }, r.id)
    )

    expect(outcome.failed).toEqual([{ id: 'a', error: 'boom a' }])
    expect(outcome.succeeded).toEqual([])
    expect(outcome.contentChanged).toEqual([])
  })

  test('classifyBatch does not swallow a store throw (an unmapped fault can never read as success)', () => {
    expect(() =>
      classifyBatch(rows.slice(0, 1), () => {
        throw new Error('unmapped')
      })
    ).toThrow('unmapped')
  })

  test('order is preserved inside all three lists and the index matches the row position', () => {
    const byIndex: (RowOutcome | FailedRow)[] = [
      'stored',
      'skipped',
      { id: 'c', error: 'boom c' } as FailedRow,
      'stored',
      'skipped'
    ]
    const given: EmbeddingRow[] = [
      row('a', 'A', 'h1'),
      row('b', 'B', 'h2'),
      row('c', 'C', 'h3'),
      row('d', 'D', 'h4'),
      row('e', 'E', 'h5')
    ]
    const seen: { id: string; index: number }[] = []

    const outcome = classifyBatch(given, (r, index) => {
      seen.push({ id: r.id, index })
      return byIndex[index]!
    })

    expect(seen).toEqual([
      { id: 'a', index: 0 },
      { id: 'b', index: 1 },
      { id: 'c', index: 2 },
      { id: 'd', index: 3 },
      { id: 'e', index: 4 }
    ])
    expect(outcome.succeeded).toEqual(['a', 'd'])
    expect(outcome.contentChanged).toEqual(['b', 'e'])
    expect(outcome.failed).toEqual([{ id: 'c', error: 'boom c' }])
  })

  test('an all-skipped batch yields succeeded === []', () => {
    const outcome = classifyBatch(rows, () => 'skipped')

    expect(outcome.succeeded).toEqual([])
    expect(outcome.contentChanged).toEqual(['a', 'b', 'c'])
    expect(outcome.failed).toEqual([])
  })
})

function vec(marker: number): Float32Array {
  const v = new Float32Array(384)
  v[0] = marker
  return v
}

function storeVec(id: string, vector: Float32Array): void {
  getDb()
    .prepare(`INSERT INTO vec_thoughts (id, embedding, scope) VALUES (?, ?, 'default')`)
    .run(id, Buffer.from(vector.buffer as ArrayBuffer, vector.byteOffset, vector.byteLength))
}

function vecMarker(id: string): number | undefined {
  const stored = getDb().prepare('SELECT embedding FROM vec_thoughts WHERE id = ?').get(id) as
    | { embedding: Uint8Array }
    | undefined
  if (!stored) return undefined
  return new Float32Array(
    stored.embedding.buffer,
    stored.embedding.byteOffset,
    stored.embedding.byteLength / 4
  )[0]
}

function pendingRowOrNull(id: string): {
  attempts: number
  is_error: number
  last_error: string | null
  content_hash: string | null
} | null {
  const found = getDb()
    .prepare(
      'SELECT attempts, is_error, last_error, content_hash FROM pending_embeddings WHERE thought_id = ?'
    )
    .get(id) as
    | { attempts: number; is_error: number; last_error: string | null; content_hash: string | null }
    | undefined
  return found ?? null
}

function midBatchFixture(): { id: string; oldHash: string; newHash: string; rows: EmbeddingRow[] } {
  const db = getDb()
  const id = seedThought({ content: 'OLD content' })
  const oldHash = `hash-old-${id}`
  const newHash = `hash-new-${id}`
  db.prepare(`UPDATE thoughts SET content = 'OLD content', content_hash = ? WHERE id = ?`).run(
    oldHash,
    id
  )
  storeVec(id, vec(1))

  const rows = findPendingEmbeddings(db, 10).filter(r => r.id === id)
  expect(rows.map(r => r.id)).toEqual([id])
  expect(rows[0]).toMatchObject({ content: 'OLD content', contentHash: oldHash })

  db.prepare(`UPDATE thoughts SET content = 'NEW content', content_hash = ? WHERE id = ?`).run(
    newHash,
    id
  )
  return { id, oldHash, newHash, rows }
}

function runBatchComposition(
  rows: EmbeddingRow[],
  embeddings: Float32Array[],
  afterStore?: () => void
): BatchOutcome {
  return runComposition(
    rows,
    embeddings,
    (batchRows, succeeded) => {
      if (succeeded.length === 0) return
      const stored = new Set(succeeded)
      deleteEmbeddedFromQueue(
        getDb(),
        batchRows.filter(r => stored.has(r.id))
      )
    },
    afterStore
  )
}

function runPreGuardComposition(
  rows: EmbeddingRow[],
  embeddings: Float32Array[],
  afterStore?: () => void
): BatchOutcome {
  return runComposition(
    rows,
    embeddings,
    (_batchRows, succeeded) => {
      if (succeeded.length > 0) deleteFromQueue(getDb(), succeeded)
    },
    afterStore
  )
}

function runComposition(
  rows: EmbeddingRow[],
  embeddings: Float32Array[],
  retire: (batchRows: EmbeddingRow[], succeeded: string[]) => void,
  afterStore?: () => void
): BatchOutcome {
  const db = getDb()
  const { succeeded, failed, contentChanged } = classifyBatch(rows, (r, i) =>
    storeRowMirror(
      () => (insertEmbedding(db, r.id, embeddings[i]!, r.contentHash) ? 'stored' : 'skipped'),
      r.id
    )
  )

  for (const f of failed) handleFailedItem(db, f.id, f.error)
  for (const id of contentChanged) handleFailedItem(db, id, CONTENT_CHANGED_REASON)
  afterStore?.()
  retire(rows, succeeded)

  return { succeeded, failed, contentChanged }
}

function runPreFixLoop(rows: EmbeddingRow[], embeddings: Float32Array[]): string[] {
  const db = getDb()
  const succeeded: string[] = []
  for (let i = 0; i < rows.length; i++) {
    const r = rows[i]!
    try {
      insertEmbedding(db, r.id, embeddings[i]!, r.contentHash)
      succeeded.push(r.id)
    } catch {}
  }
  if (succeeded.length > 0) deleteFromQueue(db, succeeded)
  return succeeded
}

function markers(vectors: Float32Array[]): number[] {
  return vectors.map(v => v[0]!)
}

describe('delete-only-succeeded invariant (#1572)', () => {
  test('AC2/AC4: a skipped row keeps its pending_embeddings row, and R1 then catches the stale vector', async () => {
    const { id, newHash, rows } = midBatchFixture()

    const outcome = runBatchComposition(rows, [vec(2)])

    expect(outcome.succeeded).toEqual([])
    expect(outcome.contentChanged).toEqual([id])
    expect(outcome.failed).toEqual([])

    expect(pendingRowOrNull(id)).toMatchObject({
      attempts: 1,
      is_error: 0,
      last_error: CONTENT_CHANGED_REASON,
      content_hash: newHash
    })
    expect(vecMarker(id)).toBe(1)

    let embedCalls = 0
    const served = await resolveCandidateEmbeddings(
      [{ id, content: 'NEW content' }],
      async texts => {
        embedCalls++
        return texts.map(() => vec(99))
      },
      getDb()
    )
    expect(markers(served)).toEqual([99])
    expect(embedCalls).toBe(1)
  })

  test('AC3 non-vacuity: the PRE-FIX loop body drops the signal, and the same fixture then serves the stale vector with 0 embed calls', async () => {
    const preFix = midBatchFixture()
    const preFixSucceeded = runPreFixLoop(preFix.rows, [vec(2)])

    expect(preFixSucceeded).toEqual([preFix.id])
    expect(pendingRowOrNull(preFix.id)).toBeNull()
    expect(vecMarker(preFix.id)).toBe(1)
    let preFixEmbedCalls = 0
    const preFixServed = await resolveCandidateEmbeddings(
      [{ id: preFix.id, content: 'NEW content' }],
      async texts => {
        preFixEmbedCalls++
        return texts.map(() => vec(99))
      },
      getDb()
    )
    expect(markers(preFixServed)).toEqual([1])
    expect(preFixEmbedCalls).toBe(0)

    const fixed = midBatchFixture()
    const fixedOutcome = runBatchComposition(fixed.rows, [vec(2)])
    expect(fixedOutcome.contentChanged).toEqual([fixed.id])
    let fixedEmbedCalls = 0
    const fixedServed = await resolveCandidateEmbeddings(
      [{ id: fixed.id, content: 'NEW content' }],
      async texts => {
        fixedEmbedCalls++
        return texts.map(() => vec(99))
      },
      getDb()
    )
    expect(markers(fixedServed)).toEqual([99])
    expect(fixedEmbedCalls).toBe(1)
  })

  test('AC8: a mixed batch deletes and writes only the stored row; the skipped row survives', async () => {
    const db = getDb()
    const storedId = seedThought({ content: 'STABLE content' })
    const skippedId = seedThought({ content: 'OLD content' })
    for (const id of [storedId, skippedId]) {
      db.prepare(`UPDATE thoughts SET content = content, content_hash = ? WHERE id = ?`).run(
        `hash-old-${id}`,
        id
      )
    }
    storeVec(skippedId, vec(7))

    const rows = findPendingEmbeddings(db, 10).filter(r => r.id === storedId || r.id === skippedId)
    expect(rows.map(r => r.id).sort()).toEqual([storedId, skippedId].sort())

    db.prepare(`UPDATE thoughts SET content = 'NEW content', content_hash = ? WHERE id = ?`).run(
      `hash-new-${skippedId}`,
      skippedId
    )

    const embeddingsByRow = new Map(rows.map(r => [r.id, r.id === skippedId ? vec(7) : vec(42)]))
    const outcome = runBatchComposition(
      rows,
      rows.map(r => embeddingsByRow.get(r.id)!)
    )

    expect(outcome.succeeded).toEqual([storedId])
    expect(outcome.contentChanged).toEqual([skippedId])
    expect(pendingRowOrNull(storedId)).toBeNull()
    expect(vecMarker(storedId)).toBe(42)
    expect(pendingRowOrNull(skippedId)).toMatchObject({
      attempts: 1,
      last_error: CONTENT_CHANGED_REASON
    })
    expect(vecMarker(skippedId)).toBe(7)
  })

  test('AC6 (local pin): a content change does not advance the failure counter, a store fault does', () => {
    const nextFailures = (outcome: BatchOutcome, rowCount: number, current: number): number =>
      outcome.failed.length === rowCount ? current + 1 : 0

    const allSkipped = classifyBatch([row('a', 'A', 'h'), row('b', 'B', 'h')], () => 'skipped')
    const allFailed = classifyBatch([row('a', 'A', 'h'), row('b', 'B', 'h')], r => ({
      id: r.id,
      error: 'boom'
    }))
    const partial = classifyBatch([row('a', 'A', 'h'), row('b', 'B', 'h')], (r, i) =>
      i === 0 ? 'stored' : { id: r.id, error: 'boom' }
    )

    expect(nextFailures(allSkipped, 2, 4)).toBe(0)
    expect(nextFailures(allFailed, 2, 4)).toBe(5)
    expect(nextFailures(partial, 2, 4)).toBe(0)
  })
})

function retireWindowFixture(): {
  id: string
  oldHash: string
  newHash: string
  rows: EmbeddingRow[]
  edit: () => void
} {
  const db = getDb()
  const id = seedThought({ content: 'OLD content' })
  const oldHash = `hash-old-${id}`
  const newHash = `hash-new-${id}`
  db.prepare(`UPDATE thoughts SET content = 'OLD content', content_hash = ? WHERE id = ?`).run(
    oldHash,
    id
  )
  storeVec(id, vec(1))

  const rows = findPendingEmbeddings(db, 10).filter(r => r.id === id)
  expect(rows.map(r => r.id)).toEqual([id])
  expect(rows[0]).toMatchObject({ content: 'OLD content', contentHash: oldHash })

  const edit = (): void => {
    db.prepare(`UPDATE thoughts SET content = 'NEW content', content_hash = ? WHERE id = ?`).run(
      newHash,
      id
    )
  }
  return { id, oldHash, newHash, rows, edit }
}

describe('the retire window between the hash check and the delete (#2471)', () => {
  test('AC1: an edit between the store and the retire keeps the thought queued, and the next poll re-embeds it', () => {
    const f = retireWindowFixture()
    let hookRan = 0

    const outcome = runBatchComposition(f.rows, [vec(2)], () => {
      hookRan++
      f.edit()
    })

    expect(hookRan).toBe(1)
    expect(outcome.succeeded).toEqual([f.id])
    expect(outcome.contentChanged).toEqual([])

    expect(vecMarker(f.id)).toBe(2)
    expect(pendingRowOrNull(f.id)).toMatchObject({ is_error: 0, content_hash: f.newHash })

    const next = findPendingEmbeddings(getDb(), 10).filter(r => r.id === f.id)
    expect(next).toMatchObject([{ content: 'NEW content', contentHash: f.newHash }])

    const second = runBatchComposition(next, [vec(3)])
    expect(second.succeeded).toEqual([f.id])
    expect(pendingRowOrNull(f.id)).toBeNull()
    expect(vecMarker(f.id)).toBe(3)
  })

  test('AC1 non-vacuity: the pre-#2471 retire drops that row and leaves the stale vector unmarked', () => {
    const f = retireWindowFixture()

    const outcome = runPreGuardComposition(f.rows, [vec(2)], f.edit)

    expect(outcome.succeeded).toEqual([f.id])
    expect(pendingRowOrNull(f.id)).toBeNull()
    expect(findPendingEmbeddings(getDb(), 10).map(r => r.id)).not.toContain(f.id)
    expect(vecMarker(f.id)).toBe(2)
  })

  test('AC2: the ordinary path retires the queue row in one pass and leaves no re-embedding work', () => {
    const db = getDb()
    const id = seedThought({ content: 'STABLE content' })
    const hash = `hash-stable-${id}`
    db.prepare('UPDATE thoughts SET content_hash = ? WHERE id = ?').run(hash, id)

    const rows = findPendingEmbeddings(db, 10).filter(r => r.id === id)
    expect(rows).toMatchObject([{ content: 'STABLE content', contentHash: hash }])

    const outcome = runBatchComposition(rows, [vec(4)])

    expect(outcome).toEqual({ succeeded: [id], failed: [], contentChanged: [] })
    expect(pendingRowOrNull(id)).toBeNull()
    expect(vecMarker(id)).toBe(4)
    expect(findPendingEmbeddings(db, 10)).toEqual([])
  })

  test('AC3: the hash-guarded delete does not strand a row whose content already changed', () => {
    const f = midBatchFixture()
    const outcome = runBatchComposition(f.rows, [vec(2)])
    expect(outcome.contentChanged).toEqual([f.id])
    expect(outcome.succeeded).toEqual([])

    deleteEmbeddedFromQueue(getDb(), f.rows)

    expect(pendingRowOrNull(f.id)).toMatchObject({ is_error: 0, content_hash: f.newHash })
    const next = findPendingEmbeddings(getDb(), 10).filter(r => r.id === f.id)
    expect(next).toMatchObject([{ content: 'NEW content', contentHash: f.newHash }])

    const second = runBatchComposition(next, [vec(5)])
    expect(second.succeeded).toEqual([f.id])
    expect(pendingRowOrNull(f.id)).toBeNull()
    expect(vecMarker(f.id)).toBe(5)
  })
})
