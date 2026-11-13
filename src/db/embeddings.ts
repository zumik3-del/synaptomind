import type { Database, SQLQueryBindings } from 'bun:sqlite'
import { sqlIn } from './utils'

export function getThoughtEmbeddingsBatch(db: Database, ids: string[]): Map<string, Float32Array> {
  const out = new Map<string, Float32Array>()
  if (ids.length === 0) return out

  try {
    const rows = db
      .prepare(`SELECT id, embedding FROM vec_thoughts WHERE id IN (${sqlIn(ids)})`)
      .all(...(ids as SQLQueryBindings[])) as { id: string; embedding: Uint8Array }[]
    for (const row of rows) {
      const bytes = row.embedding
      const source = new Float32Array(
        bytes.buffer as ArrayBuffer,
        bytes.byteOffset,
        bytes.byteLength / 4
      )
      out.set(row.id, new Float32Array(source))
    }
  } catch (err) {
    console.debug('[embeddings] vec_thoughts batch read failed:', err)
    return new Map()
  }
  return out
}

// Deliberately unfiltered by `is_error`: a dead-lettered row is never retried, so it keeps a vector
// that no longer matches its content — exactly the case the caller must catch.
export function getPendingEmbeddingIds(db: Database, ids: string[]): Set<string> {
  const out = new Set<string>()
  if (ids.length === 0) return out

  try {
    const rows = db
      .prepare(`SELECT thought_id FROM pending_embeddings WHERE thought_id IN (${sqlIn(ids)})`)
      .all(...(ids as SQLQueryBindings[])) as { thought_id: string }[]
    for (const row of rows) out.add(row.thought_id)
  } catch (err) {
    // Fails closed: reporting every id pending makes the caller embed live, never score a stale vector.
    console.debug(
      '[embeddings] pending_embeddings read failed, treating every candidate as pending:',
      err
    )
    return new Set(ids)
  }
  return out
}
