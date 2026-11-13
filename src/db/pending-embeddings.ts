import type { Database } from 'bun:sqlite'
import { insertLog } from '../logging'
import { scopeSql } from './vec-schema'

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

export function hasPendingEmbeddings(db: Database): boolean {
  return db.prepare('SELECT 1 FROM pending_embeddings WHERE is_error = 0 LIMIT 1').get() !== null
}

export function sweepOrphanedThoughts(
  db: Database,
  limit: number
): { id: string; content: string }[] {
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

// `INSERT OR IGNORE` keeps an existing row intact, so a sweep never resets attempts or a dead letter.
export function requeueEmbeddings(db: Database, ids: string[]): void {
  const createdAt = new Date().toISOString()
  const insert = db.prepare(
    'INSERT OR IGNORE INTO pending_embeddings (thought_id, created_at) VALUES (?, ?)'
  )
  const tx = db.transaction(() => {
    for (const id of ids) insert.run(id, createdAt)
  })
  tx()
}

// Retires rows regardless of freshness; the batch path must use `deleteEmbeddedFromQueue` instead.
export function deleteFromQueue(db: Database, ids: string[]) {
  const del = db.prepare('DELETE FROM pending_embeddings WHERE thought_id = ?')
  const tx = db.transaction(() => {
    for (const id of ids) del.run(id)
  })
  tx()
}

export interface EmbeddedRow {
  id: string
  contentHash: string
}

// The guard must live inside the DELETE: a content update committed since `insertEmbedding` has
// already re-queued the thought under its new hash, so deleting by id alone strands a stale vector
// with no freshness signal.
export function deleteEmbeddedFromQueue(db: Database, rows: EmbeddedRow[]): void {
  const del = db.prepare(`
    DELETE FROM pending_embeddings
    WHERE thought_id = ?
      AND NOT EXISTS (SELECT 1 FROM thoughts WHERE id = ? AND content_hash <> ?)
  `)
  const tx = db.transaction(() => {
    for (const row of rows) del.run(row.id, row.id, row.contentHash)
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
    db.prepare(
      'UPDATE pending_embeddings SET attempts = ?, last_error = ? WHERE thought_id = ?'
    ).run(nextAttempt, error, id)
  }
}

export const CONTENT_CHANGED_REASON =
  'content changed during batch — embedding skipped, re-queued for retry'

// `false` means nothing was written and the row was NOT embedded: it must stay queued, because that
// queue row is the only signal that the stored vector no longer matches the content.
export function insertEmbedding(
  db: Database,
  id: string,
  embedding: Float32Array,
  expectedHash: string
) {
  const current = db.prepare('SELECT content_hash FROM thoughts WHERE id = ?').get(id) as
    | { content_hash: string }
    | undefined
  if (current && current.content_hash !== expectedHash) {
    insertLog(
      'info',
      'embedding',
      `Stale embedding skipped for ${id} — content changed during batch`,
      { thought_id: id }
    )
    return false
  }
  // Delete by id alone: a partition predicate here silently misses a moved row. The upsert rereads
  // the partition in the same statement, so a thought that moved mid-batch lands in its new scope.
  db.run('DELETE FROM vec_thoughts WHERE id = ?', [id])
  db.run(
    `INSERT INTO vec_thoughts (id, embedding, scope)
     SELECT ?, ?, ${scopeSql('t')} FROM thoughts t WHERE t.id = ?`,
    [
      id,
      Buffer.from(embedding.buffer as ArrayBuffer, embedding.byteOffset, embedding.byteLength),
      id
    ]
  )
  return true
}
