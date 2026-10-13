import type { Database, SQLQueryBindings } from 'bun:sqlite'
import { sqlIn } from './utils'

/**
 * Batch read of persisted embeddings from `vec_thoughts`.
 *
 * The embedding pipeline (`pending_embeddings` trigger + content hash guard)
 * already stores one vector per embedded thought, so services that need vectors
 * for a candidate list must read them here instead of re-running the embedder.
 * A stored vector is only as fresh as the last successful embedder pass — pair
 * this read with `getPendingEmbeddingIds` to catch the rows whose content
 * changed after the vector was written.
 */
export function getThoughtEmbeddingsBatch(db: Database, ids: string[]): Map<string, Float32Array> {
  const out = new Map<string, Float32Array>()
  if (ids.length === 0) return out

  try {
    const rows = db
      .prepare(`SELECT id, embedding FROM vec_thoughts WHERE id IN (${sqlIn(ids)})`)
      .all(...(ids as SQLQueryBindings[])) as { id: string; embedding: Uint8Array }[]
    for (const row of rows) {
      const bytes = row.embedding
      // Own copy, defence-in-depth: bun:sqlite already hands back a Uint8Array
      // over a fresh, exactly-sized ArrayBuffer, so nothing aliases today — the
      // copy keeps that guarantee if the driver's buffer reuse ever changes.
      const source = new Float32Array(bytes.buffer as ArrayBuffer, bytes.byteOffset, bytes.byteLength / 4)
      out.set(row.id, new Float32Array(source))
    }
  } catch (err) {
    // vec0 is unavailable on `:memory:` databases and a surprise query failure
    // must degrade to "no stored vectors" (the caller then embeds), not throw —
    // but the failure is logged, otherwise a transient fault silently re-embeds
    // the whole candidate set with no trace (sibling: `db/search-vector.ts`).
    console.debug('[embeddings] vec_thoughts batch read failed:', err)
    return new Map()
  }
  return out
}

/**
 * Candidate ids whose embedding is queued in `pending_embeddings`, i.e. whose
 * content changed after its stored vector was written (the v035 trigger queues
 * the row on INSERT and on UPDATE OF content, and the worker refreshes
 * `vec_thoughts` later).
 *
 * Deliberately unfiltered: `is_error = 1` rows are dead-lettered and NEVER
 * retried, so they keep a vector that no longer matches their content — exactly
 * the permanent case the caller must catch, not skip.
 *
 * A FAILED READ fails CLOSED but AVAILABLE: every requested id is reported
 * pending. The caller (`resolveCandidateEmbeddings`) resolves a pending id by
 * embedding it live, so "all pending" is safe — it can never score a candidate
 * from a stale vector — and stays available, whereas throwing degraded the
 * whole `edge_suggestions` run and failed the auto-cluster job on one transient
 * fault. The failure is logged, so the missing freshness set leaves a trace
 * (sibling: `getThoughtEmbeddingsBatch` above, which degrades to "no stored
 * vectors" and lets the caller embed).
 */
export function getPendingEmbeddingIds(db: Database, ids: string[]): Set<string> {
  const out = new Set<string>()
  if (ids.length === 0) return out

  try {
    const rows = db
      .prepare(`SELECT thought_id FROM pending_embeddings WHERE thought_id IN (${sqlIn(ids)})`)
      .all(...(ids as SQLQueryBindings[])) as { thought_id: string }[]
    for (const row of rows) out.add(row.thought_id)
  } catch (err) {
    console.debug('[embeddings] pending_embeddings read failed, treating every candidate as pending:', err)
    return new Set(ids)
  }
  return out
}
