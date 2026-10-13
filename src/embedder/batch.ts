/**
 * Batch outcome classification for the embedder worker.
 *
 * Kept out of `embedder-process.ts` because that module is a side-effect module
 * (it runs `initDb()`, validates the model and starts the poll worker on
 * import), so the contract below could not be exercised without spawning the
 * child process. This module is pure: no DB handle, no queue side effects.
 */

/** One queue row as the batch loop sees it. */
export interface EmbeddingRow {
  id: string
  content: string
  contentHash: string
}

/**
 * What storing one row did. Only 'stored' wrote a vector.
 *
 * A thrown store attempt is NOT part of this union: it is reported as a
 * `FailedRow`, so the fault carries its message and cannot be confused with the
 * flag-shaped outcomes.
 */
export type RowOutcome = 'stored' | 'skipped'

/** A row whose store attempt threw. */
export interface FailedRow {
  id: string
  error: string
}

/**
 * Classification of one batch. Only `succeeded` may be dropped from
 * `pending_embeddings`; the other two stay queued and are retried.
 */
export interface BatchOutcome {
  succeeded: string[]
  failed: FailedRow[]
  contentChanged: string[]
}

/**
 * Classify every row of one batch, in order, through the injected `store`.
 *
 * The point of the classification is the "skipped" outcome — `insertEmbedding`
 * returning `false` because the content changed while the batch was being
 * embedded, which means NOTHING was written. Reading that as success is the
 * #1572 defect: the id would land in `succeeded`, `deleteFromQueue` would drop
 * the FRESH queue row, and the stale `vec_thoughts` vector would survive with
 * NO freshness signal, so `resolveCandidateEmbeddings` (#1569) would score the
 * candidate from pre-edit meaning forever. Only 'stored' licenses the delete.
 *
 * `store` is injected so the batch contract is observable without a DB or the
 * embedder child process.
 */
export function classifyBatch(
  rows: EmbeddingRow[],
  store: (row: EmbeddingRow, index: number) => RowOutcome | FailedRow
): BatchOutcome {
  const outcome: BatchOutcome = { succeeded: [], failed: [], contentChanged: [] }
  rows.forEach((row, index) => {
    const result = store(row, index)
    if (result === 'stored') {
      // The ONLY outcome that licenses dropping the queue row: a vector that
      // matches the row's current content_hash was written.
      outcome.succeeded.push(row.id)
    } else if (result === 'skipped') {
      outcome.contentChanged.push(row.id)
    } else {
      outcome.failed.push({ id: row.id, error: result.error })
    }
  })
  return outcome
}
