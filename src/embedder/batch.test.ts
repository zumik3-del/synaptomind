import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { getDb } from '../db/container'
import { closeDb } from '../db/init'
import { resolveCandidateEmbeddings } from '../services/candidate-embeddings.service'
import { createTestDb, seedThought } from '../test/helpers'
import { type BatchOutcome, type EmbeddingRow, type FailedRow, type RowOutcome, classifyBatch } from './batch'
import { CONTENT_CHANGED_REASON, deleteFromQueue, findPendingEmbeddings, handleFailedItem, insertEmbedding } from './queue'

/**
 * Task #1573 — regression pins for #1572: `insertEmbedding` returning `false`
 * (content changed while the batch was being embedded) is NOT a success.
 *
 * The defect: the pre-#1572 loop body ignored the return value, so a skipped id
 * reached `deleteFromQueue`, which dropped the FRESH `pending_embeddings` row.
 * That queue row is the only freshness signal `resolveCandidateEmbeddings`
 * (#1569, R1) has, so the stale `vec_thoughts` vector was then served — and
 * scored — as if it matched the current content, permanently.
 */

beforeEach(() => {
  createTestDb()
  // vec_thoughts is a vec0 virtual table — v002 skips it on `:memory:` databases,
  // so stub it as a plain table (same approach as queue.test.ts).
  getDb().prepare('CREATE TABLE IF NOT EXISTS vec_thoughts (id TEXT PRIMARY KEY, embedding BLOB)').run()
})

afterEach(closeDb)

function row(id: string, content: string, contentHash: string): EmbeddingRow {
  return { id, content, contentHash }
}

/**
 * Mirror of `embedder-process.ts:57-64` (`storeRow`), which is private to a
 * side-effect module. It exists here because `classifyBatch` deliberately does
 * not catch a store throw: the caller maps the fault to a `FailedRow` so the
 * message travels with it. The real `storeRow` is driven in
 * `embedder-batch-loop.suite.ts`.
 */
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
    // Interleaved outcomes: the index handed to `store` must stay positional —
    // `embedder-process.ts:81` pairs row i with `embeddings[i]`.
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

// ── the delete-only-`succeeded` invariant, against a real DB ─────────────────

/** `vec_thoughts` is `FLOAT[384]`; slot 0 is the identity marker of the vector. */
function vec(marker: number): Float32Array {
  const v = new Float32Array(384)
  v[0] = marker
  return v
}

function storeVec(id: string, vector: Float32Array): void {
  getDb()
    .prepare('INSERT INTO vec_thoughts (id, embedding) VALUES (?, ?)')
    .run(id, Buffer.from(vector.buffer as ArrayBuffer, vector.byteOffset, vector.byteLength))
}

/** Identity marker of the stored vector, or undefined when no row exists. */
function vecMarker(id: string): number | undefined {
  const stored = getDb().prepare('SELECT embedding FROM vec_thoughts WHERE id = ?').get(id) as
    | { embedding: Uint8Array }
    | undefined
  if (!stored) return undefined
  return new Float32Array(stored.embedding.buffer, stored.embedding.byteOffset, stored.embedding.byteLength / 4)[0]
}

function pendingRowOrNull(
  id: string
): { attempts: number; is_error: number; last_error: string | null; content_hash: string | null } | null {
  const found = getDb()
    .prepare('SELECT attempts, is_error, last_error, content_hash FROM pending_embeddings WHERE thought_id = ?')
    .get(id) as { attempts: number; is_error: number; last_error: string | null; content_hash: string | null } | undefined
  return found ?? null
}

/**
 * Build the mid-batch content-change fixture and return the batch the worker
 * read, i.e. the rows `findPendingEmbeddings` handed to `classifyBatch`.
 *
 * The developer's gotcha (task #1572 handoff): `seedThought` leaves
 * `content_hash` NULL and the v035 trigger records the row's CURRENT hash, so a
 * skip only reproduces when the hash truly diverges. Content and `content_hash`
 * are therefore written TOGETHER, and the divergence is created after the batch
 * was built — the embed-window edit production has to survive.
 */
function midBatchFixture(): { id: string; rows: EmbeddingRow[] } {
  const db = getDb()
  const id = seedThought({ content: 'OLD content' })
  db.prepare(`UPDATE thoughts SET content = 'OLD content', content_hash = 'hash-old' WHERE id = ?`).run(id)
  // the vector a previous pass wrote for OLD content — now stale, still on disk
  storeVec(id, vec(1))

  const rows = findPendingEmbeddings(10).filter(r => r.id === id)
  expect(rows.map(r => r.id)).toEqual([id])
  expect(rows[0]).toMatchObject({ content: 'OLD content', contentHash: 'hash-old' })

  // mid-batch edit: NEW content + NEW hash; the v035 trigger re-queues the row
  // with the NEW hash — the FRESH queue row the pre-fix loop deleted.
  db.prepare(`UPDATE thoughts SET content = 'NEW content', content_hash = 'hash-new' WHERE id = ?`).run(id)
  return { id, rows }
}

/**
 * The shipped batch composition (`embedder-process.ts:81-89`) driven with the
 * real classifier, the real `insertEmbedding` and the real `deleteFromQueue`.
 *
 * `embedder-process.ts` cannot be imported: it is a side-effect module (it calls
 * `initDb()`, validates the model and starts the poll worker on import). The loop
 * itself is driven for real in `embedder-batch-loop.suite.ts`; this mirror pins
 * the composition's DB effects without spawning the embedder child.
 */
function runBatchComposition(rows: EmbeddingRow[], embeddings: Float32Array[]): BatchOutcome {
  const { succeeded, failed, contentChanged } = classifyBatch(rows, (r, i) =>
    storeRowMirror(() => (insertEmbedding(r.id, embeddings[i]!, r.contentHash) ? 'stored' : 'skipped'), r.id)
  )

  for (const f of failed) handleFailedItem(f.id, f.error)
  for (const id of contentChanged) handleFailedItem(id, CONTENT_CHANGED_REASON)
  if (succeeded.length > 0) deleteFromQueue(succeeded)

  return { succeeded, failed, contentChanged }
}

/** The PRE-FIX loop body: the store result is ignored, every row counts as succeeded. */
function runPreFixLoop(rows: EmbeddingRow[], embeddings: Float32Array[]): string[] {
  const succeeded: string[] = []
  for (let i = 0; i < rows.length; i++) {
    const r = rows[i]!
    try {
      insertEmbedding(r.id, embeddings[i]!, r.contentHash)
      succeeded.push(r.id)
    } catch {
      // the pre-fix body swallowed the fault for `succeeded` accounting
    }
  }
  if (succeeded.length > 0) deleteFromQueue(succeeded)
  return succeeded
}

function markers(vectors: Float32Array[]): number[] {
  return vectors.map(v => v[0]!)
}

describe('delete-only-succeeded invariant (#1572)', () => {
  test('AC2/AC4: a skipped row keeps its pending_embeddings row, and R1 then catches the stale vector', async () => {
    const { id, rows } = midBatchFixture()

    const outcome = runBatchComposition(rows, [vec(2)])

    expect(outcome.succeeded).toEqual([])
    expect(outcome.contentChanged).toEqual([id])
    expect(outcome.failed).toEqual([])

    // AC2: nothing was written, so the queue row must SURVIVE — it is the only
    // freshness signal R1 has. AC5: the attempt is recorded, with the shared reason.
    expect(pendingRowOrNull(id)).toMatchObject({
      attempts: 1,
      is_error: 0,
      last_error: CONTENT_CHANGED_REASON,
      content_hash: 'hash-new'
    })
    // AC4: the stale vector is still physically on disk (nothing overwrote it)…
    expect(vecMarker(id)).toBe(1)

    // …and `resolveCandidateEmbeddings` serves the LIVE embed of the current
    // content, never the stale marker-1 vector: the pending row still queued is
    // what makes R1 catch it.
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
    // Pre-fix path: the identical fixture through the OLD loop body.
    const preFix = midBatchFixture()
    const preFixSucceeded = runPreFixLoop(preFix.rows, [vec(2)])

    expect(preFixSucceeded).toEqual([preFix.id])
    // the FRESH queue row was deleted even though NOTHING was written…
    expect(pendingRowOrNull(preFix.id)).toBeNull()
    // …the stale vector survived on disk…
    expect(vecMarker(preFix.id)).toBe(1)
    // …and R1 can no longer see the staleness: the stale vector is served as-is.
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

    // Fixed path: same fixture, fresh vector — the defect above is not vacuous.
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
      db.prepare(`UPDATE thoughts SET content = content, content_hash = 'hash-old' WHERE id = ?`).run(id)
    }
    storeVec(skippedId, vec(7))

    const rows = findPendingEmbeddings(10).filter(r => r.id === storedId || r.id === skippedId)
    expect(rows.map(r => r.id).sort()).toEqual([storedId, skippedId].sort())

    // Only `skippedId` is edited mid-batch; `storedId` keeps the hash the batch read.
    db.prepare(`UPDATE thoughts SET content = 'NEW content', content_hash = 'hash-new' WHERE id = ?`).run(skippedId)

    const embeddingsByRow = new Map(rows.map(r => [r.id, r.id === skippedId ? vec(7) : vec(42)]))
    const outcome = runBatchComposition(
      rows,
      rows.map(r => embeddingsByRow.get(r.id)!)
    )

    expect(outcome.succeeded).toEqual([storedId])
    expect(outcome.contentChanged).toEqual([skippedId])
    // success path unchanged: the queue row is gone and the vector is written
    expect(pendingRowOrNull(storedId)).toBeNull()
    expect(vecMarker(storedId)).toBe(42)
    // the skipped row keeps its queue row and its stale vector
    expect(pendingRowOrNull(skippedId)).toMatchObject({ attempts: 1, last_error: CONTENT_CHANGED_REASON })
    expect(vecMarker(skippedId)).toBe(7)
  })

  test('AC6 (local pin): a content change does not advance the failure counter, a store fault does', () => {
    // The expression shipped at `embedder-process.ts:134` — backoff tracks
    // EMBEDDER health, so skips must not look like a mass embedder failure. The
    // real loop's backoff behaviour is driven in `embedder-batch-loop.suite.ts`.
    const nextFailures = (outcome: BatchOutcome, rowCount: number, current: number): number =>
      outcome.failed.length === rowCount ? current + 1 : 0

    const allSkipped = classifyBatch([row('a', 'A', 'h'), row('b', 'B', 'h')], () => 'skipped')
    const allFailed = classifyBatch([row('a', 'A', 'h'), row('b', 'B', 'h')], r => ({ id: r.id, error: 'boom' }))
    const partial = classifyBatch([row('a', 'A', 'h'), row('b', 'B', 'h')], (r, i) =>
      i === 0 ? 'stored' : { id: r.id, error: 'boom' }
    )

    expect(nextFailures(allSkipped, 2, 4)).toBe(0)
    expect(nextFailures(allFailed, 2, 4)).toBe(5)
    expect(nextFailures(partial, 2, 4)).toBe(0)
  })
})
