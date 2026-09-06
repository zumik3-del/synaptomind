import { getDb } from '../db/container'
import { insertLog } from '../logging'

export const MAX_ATTEMPTS = 10

export function findPendingEmbeddings(limit: number): { id: string; content: string; contentHash: string }[] {
  const db = getDb()
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
export function sweepOrphanedThoughts(limit: number): { id: string; content: string }[] {
  const db = getDb()
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

export function deleteFromQueue(ids: string[]) {
  const db = getDb()
  const del = db.prepare('DELETE FROM pending_embeddings WHERE thought_id = ?')
  const tx = db.transaction(() => {
    for (const id of ids) del.run(id)
  })
  tx()
}

export function handleFailedItem(id: string, error: string) {
  const db = getDb()
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

export function insertEmbedding(id: string, embedding: Float32Array, expectedHash: string) {
  const db = getDb()
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
