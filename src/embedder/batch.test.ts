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
    .prepare(`INSERT INTO vec_thoughts (id, embedding, scope) VALUES (?, ?, 'default')`)
    .run(id, Buffer.from(vector.buffer as ArrayBuffer, vector.byteOffset, vector.byteLength))
}

/** Identity marker of the stored vector, or undefined when no row exists. */
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
function midBatchFixture(): { id: string; oldHash: string; newHash: string; rows: EmbeddingRow[] } {
  const db = getDb()
  const id = seedThought({ content: 'OLD content' })
  // Per-thought hashes: two live thoughts may not share (content_hash, project)
  // — the v046 content-dedupe index — and one test seeds several fixtures.
  const oldHash = `hash-old-${id}`
  const newHash = `hash-new-${id}`
  db.prepare(`UPDATE thoughts SET content = 'OLD content', content_hash = ? WHERE id = ?`).run(
    oldHash,
    id
  )
  // the vector a previous pass wrote for OLD content — now stale, still on disk
  storeVec(id, vec(1))

  const rows = findPendingEmbeddings(db, 10).filter(r => r.id === id)
  expect(rows.map(r => r.id)).toEqual([id])
  expect(rows[0]).toMatchObject({ content: 'OLD content', contentHash: oldHash })

  // mid-batch edit: NEW content + NEW hash; the v035 trigger re-queues the row
  // with the NEW hash — the FRESH queue row the pre-fix loop deleted.
  db.prepare(`UPDATE thoughts SET content = 'NEW content', content_hash = ? WHERE id = ?`).run(
    newHash,
    id
  )
  return { id, oldHash, newHash, rows }
}

/**
 * The shipped batch composition (`embedder-process.ts` `processOneDb`) driven
 * with the real classifier, the real `insertEmbedding` and the real
 * `deleteEmbeddedFromQueue`.
 *
 * `embedder-process.ts` cannot be imported: it is a side-effect module (it calls
 * `initDb()`, validates the model and starts the poll worker on import). The loop
 * itself is driven for real in `embedder-batch-loop.suite.ts`; this mirror pins
 * the composition's DB effects without spawning the embedder child.
 */
function runBatchComposition(
  rows: EmbeddingRow[],
  embeddings: Float32Array[],
  /**
   * Runs after EVERY store (hash check + vector write) and before the retire
   * step — the #2471 window, where a server-side content update can land.
   */
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

/** The same composition as it shipped BEFORE #2471: retire every `succeeded` id. */
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

/** The PRE-FIX loop body: the store result is ignored, every row counts as succeeded. */
function runPreFixLoop(rows: EmbeddingRow[], embeddings: Float32Array[]): string[] {
  const db = getDb()
  const succeeded: string[] = []
  for (let i = 0; i < rows.length; i++) {
    const r = rows[i]!
    try {
      insertEmbedding(db, r.id, embeddings[i]!, r.contentHash)
      succeeded.push(r.id)
    } catch {
      // the pre-fix body swallowed the fault for `succeeded` accounting
    }
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

    // AC2: nothing was written, so the queue row must SURVIVE — it is the only
    // freshness signal R1 has. AC5: the attempt is recorded, with the shared reason.
    expect(pendingRowOrNull(id)).toMatchObject({
      attempts: 1,
      is_error: 0,
      last_error: CONTENT_CHANGED_REASON,
      content_hash: newHash
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
      // One hash per thought: the v046 content-dedupe index covers live rows.
      db.prepare(`UPDATE thoughts SET content = content, content_hash = ? WHERE id = ?`).run(
        `hash-old-${id}`,
        id
      )
    }
    storeVec(skippedId, vec(7))

    const rows = findPendingEmbeddings(db, 10).filter(r => r.id === storedId || r.id === skippedId)
    expect(rows.map(r => r.id).sort()).toEqual([storedId, skippedId].sort())

    // Only `skippedId` is edited mid-batch; `storedId` keeps the hash the batch read.
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
    // success path unchanged: the queue row is gone and the vector is written
    expect(pendingRowOrNull(storedId)).toBeNull()
    expect(vecMarker(storedId)).toBe(42)
    // the skipped row keeps its queue row and its stale vector
    expect(pendingRowOrNull(skippedId)).toMatchObject({
      attempts: 1,
      last_error: CONTENT_CHANGED_REASON
    })
    expect(vecMarker(skippedId)).toBe(7)
  })

  test('AC6 (local pin): a content change does not advance the failure counter, a store fault does', () => {
    // The expression shipped at `embedder-process.ts:134` — backoff tracks
    // EMBEDDER health, so skips must not look like a mass embedder failure. The
    // real loop's backoff behaviour is driven in `embedder-batch-loop.suite.ts`.
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

// ── the retire window: an edit BETWEEN the hash check and the delete (#2471) ──
//
// #1572 fixed the case where the content changes BEFORE `insertEmbedding` runs
// (the store is skipped and the id never reaches the retire step). The window
// #2471 closes is later: the store matched the hash and wrote the vector, and
// the edit lands before the batch retires the queue row. The v035 trigger has
// already replaced that row under the NEW hash, so an unconditional delete by id
// drops the only freshness signal and the just-written vector goes stale with
// nothing left to repair it (audit F8).

/**
 * The #2471 fixture: a queued thought with a matching old hash and a stale
 * `vec_thoughts` row from a previous pass. `edit` is the server-side content
 * update; the caller decides WHERE in the batch it lands.
 */
function retireWindowFixture(): {
  id: string
  oldHash: string
  newHash: string
  rows: EmbeddingRow[]
  edit: () => void
} {
  const db = getDb()
  const id = seedThought({ content: 'OLD content' })
  // Per-thought hashes: the v046 content-dedupe index forbids two live thoughts
  // sharing one (content_hash, project) pair.
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

    // Non-vacuous interleaving: the hook really ran in the window, and the store
    // itself had already matched the OLD hash (so the id IS licensed to retire).
    expect(hookRan).toBe(1)
    expect(outcome.succeeded).toEqual([f.id])
    expect(outcome.contentChanged).toEqual([])

    // The vector written from OLD content is on disk…
    expect(vecMarker(f.id)).toBe(2)
    // …and the queue row SURVIVED, carrying the hash of the NEW content: the
    // guarded delete saw the mismatch and dropped nothing.
    expect(pendingRowOrNull(f.id)).toMatchObject({ is_error: 0, content_hash: f.newHash })

    // Next poll: the row is handed out again with the current content/hash, so
    // the stale vector cannot outlive this batch…
    const next = findPendingEmbeddings(getDb(), 10).filter(r => r.id === f.id)
    expect(next).toMatchObject([{ content: 'NEW content', contentHash: f.newHash }])

    // …and the re-embed retires it.
    const second = runBatchComposition(next, [vec(3)])
    expect(second.succeeded).toEqual([f.id])
    expect(pendingRowOrNull(f.id)).toBeNull()
    expect(vecMarker(f.id)).toBe(3)
  })

  test('AC1 non-vacuity: the pre-#2471 retire drops that row and leaves the stale vector unmarked', () => {
    const f = retireWindowFixture()

    const outcome = runPreGuardComposition(f.rows, [vec(2)], f.edit)

    expect(outcome.succeeded).toEqual([f.id])
    // the just-requeued row is gone, so nothing will ever replace the vector…
    expect(pendingRowOrNull(f.id)).toBeNull()
    expect(findPendingEmbeddings(getDb(), 10).map(r => r.id)).not.toContain(f.id)
    // …while the vector on disk says nothing about the content it was built from.
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
    // ONE pass: the row is gone, the vector is the one just written…
    expect(pendingRowOrNull(id)).toBeNull()
    expect(vecMarker(id)).toBe(4)
    // …and the next poll has nothing to do for this thought — an unchanged
    // thought is never re-embedded by the guard's second chance.
    expect(findPendingEmbeddings(db, 10)).toEqual([])
  })

  test('AC3: the hash-guarded delete does not strand a row whose content already changed', () => {
    // The #1572 fixture: the edit lands BEFORE the batch, so the store skips and
    // the row is classified `contentChanged` — it never even reaches `succeeded`.
    const f = midBatchFixture()
    const outcome = runBatchComposition(f.rows, [vec(2)])
    expect(outcome.contentChanged).toEqual([f.id])
    expect(outcome.succeeded).toEqual([])

    // Belt and braces: hand the same stale row to the retire path directly. The
    // guard must delete NOTHING, because the batch hash no longer matches.
    deleteEmbeddedFromQueue(getDb(), f.rows)

    expect(pendingRowOrNull(f.id)).toMatchObject({ is_error: 0, content_hash: f.newHash })
    // Not stranded: the row is still the freshness signal the next poll acts on.
    const next = findPendingEmbeddings(getDb(), 10).filter(r => r.id === f.id)
    expect(next).toMatchObject([{ content: 'NEW content', contentHash: f.newHash }])

    const second = runBatchComposition(next, [vec(5)])
    expect(second.succeeded).toEqual([f.id])
    expect(pendingRowOrNull(f.id)).toBeNull()
    expect(vecMarker(f.id)).toBe(5)
  })
})
