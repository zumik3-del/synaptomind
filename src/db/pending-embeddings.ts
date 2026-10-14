import type { Database } from 'bun:sqlite'
import { insertLog } from '../logging'

export const MAX_ATTEMPTS = 10

export function findPendingEmbeddings(
  db: Database,
  limit: number
): { id: string; content: string; contentHash: string }[] {
  return db
    .prepare(`
    SELECT p.thought_id AS id, t.content, t.content_hash AS contentHash
    FROM pending_embeddings p
    JOIN thoughts t ON t.id = p.thought_id
    WHERE p.is_error = 0
    ORDER BY p.created_at
    LIMIT ?
  `)
    .all(limit) as { id: string; content: string; contentHash: string }[]
}

// Archive-status thoughts are excluded from default search — re-embedding them
// would be wasted compute on rows the search sweep keeps skipping.
export function sweepOrphanedThoughts(db: Database, limit: number): { id: string; content: string }[] {
  return db
    .prepare(`
    SELECT t.id, t.content FROM thoughts t
    LEFT JOIN vec_thoughts v ON t.id = v.id
    LEFT JOIN pending_embeddings p ON t.id = p.thought_id
    WHERE v.id IS NULL AND p.thought_id IS NULL AND t.status != 'archived'
    LIMIT ?
  `)
    .all(limit) as { id: string; content: string }[]
}

/**
 * Queue `ids` for embedding, ignoring rows that are already queued.
 *
 * `INSERT OR IGNORE` keeps an existing row intact, so a thought that already
 * carries attempts / a dead-letter marker is not silently reset by a sweep.
 * The sweep calls this for orphaned thoughts (`sweepOrphanedThoughts`) and the
 * next regular batch picks them up.
 */
export function requeueEmbeddings(db: Database, ids: string[]): void {
  const createdAt = new Date().toISOString()
  const insert = db.prepare('INSERT OR IGNORE INTO pending_embeddings (thought_id, created_at) VALUES (?, ?)')
  const tx = db.transaction(() => {
    for (const id of ids) insert.run(id, createdAt)
  })
  tx()
}

export function deleteFromQueue(db: Database, ids: string[]) {
  const del = db.prepare('DELETE FROM pending_embeddings WHERE thought_id = ?')
  const tx = db.transaction(() => {
    for (const id of ids) del.run(id)
  })
  tx()
}

export function handleFailedItem(db: Database, id: string, error: string) {
  const row = db.prepare('SELECT attempts FROM pending_embeddings WHERE thought_id = ?').get(id) as
    | { attempts: number }
    | undefined
  const nextAttempt = (row?.attempts ?? 0) + 1

  if (nextAttempt >= MAX_ATTEMPTS) {
    db.prepare(
      'UPDATE pending_embeddings SET attempts = ?, last_error = ?, is_error = 1, error = ? WHERE thought_id = ?'
    ).run(nextAttempt, error, error, id)
    insertLog('warning', 'embedding', `Thought ${id} dead-lettered after ${nextAttempt} attempts`, {
      thought_id: id,
      attempts: nextAttempt,
      error
    })
  } else {
    db.prepare('UPDATE pending_embeddings SET attempts = ?, last_error = ? WHERE thought_id = ?').run(
      nextAttempt,
      error,
      id
    )
  }
}

/**
 * Why `insertEmbedding` skipped a row, as recorded on the queue row and in the
 * worker's log. Single-sourced here: the producer (`insertEmbedding` below) and
 * the batch classifier (`embedder-process.ts`) must not drift apart, since a
 * mismatch would silently change how a mass content change is reported.
 *
 * Deliberately NOT a failure of the embedder: the batch was embedded from
 * content that is already obsolete, and the next poll re-reads the row, so this
 * skip is retryable work rather than a fault (see `embedder-process.ts`).
 */
export const CONTENT_CHANGED_REASON = 'content changed during batch — embedding skipped, re-queued for retry'

/**
 * Write the vector for `id`, but only while its content still matches
 * `expectedHash`.
 *
 * Returns `true` when the vector was written, `false` when the row was SKIPPED
 * because its content changed after the batch was built — in that case NOTHING
 * is written and the caller must treat the row as unembedded: it may not be
 * dropped from `pending_embeddings`, because that queue row is the only signal
 * that the (still stale) `vec_thoughts` vector no longer matches the content
 * (task #1572). The caller retries it on the next poll.
 */
export function insertEmbedding(db: Database, id: string, embedding: Float32Array, expectedHash: string) {
  const current = db.prepare('SELECT content_hash FROM thoughts WHERE id = ?').get(id) as { content_hash: string } | undefined
  if (current && current.content_hash !== expectedHash) {
    insertLog('info', 'embedding', `Stale embedding skipped for ${id} — content changed during batch`, { thought_id: id })
    return false
  }
  db.run('DELETE FROM vec_thoughts WHERE id = ?', [id])
  db.run(
    'INSERT INTO vec_thoughts (id, embedding) VALUES (?, ?)',
    [id, Buffer.from(embedding.buffer as ArrayBuffer, embedding.byteOffset, embedding.byteLength)]
  )
  return true
}
