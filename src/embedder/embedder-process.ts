import { config } from '../config'
import {
  deleteGitQueueItems,
  findPendingGitEmbeddings,
  handleFailedGitItem,
  insertGitEmbedding
} from '../db/git_commits'
import { getDb } from '../db/container'
import { initDb } from '../db/init'
import { insertLog } from '../logging'
import { generateEmbedding, generateEmbeddings, resetExtractor } from './model'
import { ensureModelFiles } from './model-validator'

const BATCH_SIZE = 8
const MAX_CONSECUTIVE_FAILURES = 5
const MAX_ATTEMPTS = 10
const SWEEP_INTERVAL_MS = 5 * 60 * 1000 // 5 minutes
let pollTimer: ReturnType<typeof setInterval> | null = null
let sweepTimer: ReturnType<typeof setInterval> | null = null
let idleTimer: ReturnType<typeof setTimeout> | null = null
let consecutiveFailures = 0
let currentBackoff = 1

function resetIdleTimer() {
  if (idleTimer) clearTimeout(idleTimer)
  if (config.embedder.precache) {
    // Precache mode: keep the embedder process (and its model) resident.
    idleTimer = null
    return
  }
  idleTimer = setTimeout(() => {
    console.log('[embedder] idle timeout, exiting process')
    insertLog('debug', 'embedding', 'Model unloaded (idle)', {
      idleMinutes: config.embedder.idleTimeoutMs / 60000
    })
    process.send?.({ type: 'exiting' })
    if (pollTimer) clearInterval(pollTimer)
    if (sweepTimer) clearInterval(sweepTimer)
    resetExtractor()
    process.exit(0)
  }, config.embedder.idleTimeoutMs)
}

function findPendingEmbeddings(): { id: string; content: string }[] {
  const db = getDb()
  return db
    .prepare(`
    SELECT p.thought_id AS id, t.content FROM pending_embeddings p
    JOIN thoughts t ON t.id = p.thought_id
    WHERE p.is_error = 0
    ORDER BY p.created_at
    LIMIT ?
  `)
    .all(BATCH_SIZE) as { id: string; content: string }[]
}

function sweepOrphanedThoughts(): { id: string; content: string }[] {
  const db = getDb()
  return db
    .prepare(`
    SELECT t.id, t.content FROM thoughts t
    LEFT JOIN vec_thoughts v ON t.id = v.id
    LEFT JOIN pending_embeddings p ON t.id = p.thought_id
    WHERE v.id IS NULL AND p.thought_id IS NULL
    LIMIT ?
  `)
    .all(BATCH_SIZE) as { id: string; content: string }[]
}

// A8: a git commit with no embedding row and not currently in the queue would
// otherwise never be embedded (thoughts have an equivalent sweep). Re-queue it.
function sweepOrphanedGitCommits(): { id: string; content: string }[] {
  const db = getDb()
  return db
    .prepare(`
    SELECT gc.id, gc.message AS content FROM git_commits gc
    LEFT JOIN vec_git_commits v ON gc.id = v.id
    LEFT JOIN pending_git_embeddings p ON gc.id = p.commit_id
    WHERE v.id IS NULL AND p.commit_id IS NULL
    LIMIT ?
  `)
    .all(BATCH_SIZE) as { id: string; content: string }[]
}

function deleteFromQueue(ids: string[]) {
  const db = getDb()
  const del = db.prepare('DELETE FROM pending_embeddings WHERE thought_id = ?')
  const tx = db.transaction(() => {
    for (const id of ids) del.run(id)
  })
  tx()
}

function handleFailedItem(id: string, error: string) {
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

function insertEmbedding(id: string, embedding: Float32Array) {
  const db = getDb()
  db.run('DELETE FROM vec_thoughts WHERE id = ?', [id])
  db.run(
    'INSERT INTO vec_thoughts (id, embedding) VALUES (?, ?)',
    [id, Buffer.from(embedding.buffer as ArrayBuffer, embedding.byteOffset, embedding.byteLength)]
  )
}

function reschedule() {
  if (pollTimer) {
    clearInterval(pollTimer)
    pollTimer = null
  }
  const interval = config.embedder.pollIntervalMs * currentBackoff
  pollTimer = setInterval(processBatch, interval)
}

async function processBatch(): Promise<void> {
  try {
    const rows = findPendingEmbeddings()
    if (rows.length === 0) {
      consecutiveFailures = 0
      if (currentBackoff !== 1) {
        currentBackoff = 1
        reschedule()
      }
      return
    }

    const embeddings = await generateEmbeddings(rows.map(r => r.content))
    const succeeded: string[] = []
    const failed: { id: string; error: string }[] = []

    for (let i = 0; i < rows.length; i++) {
      const row = rows[i]
      try {
        insertEmbedding(row.id, embeddings[i])
        succeeded.push(row.id)
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err)
        failed.push({ id: row.id, error: msg })
      }
    }

    if (succeeded.length > 0) deleteFromQueue(succeeded)
    for (const f of failed) handleFailedItem(f.id, f.error)

    if (failed.length > 0 && succeeded.length > 0) {
      insertLog('warning', 'embedding', `${failed.length} of ${rows.length} thought(s) failed, requeued`, {
        failedCount: failed.length,
        total: rows.length,
        errors: failed.map(f => ({ id: f.id, error: f.error }))
      })
    } else if (failed.length === rows.length) {
      insertLog('error', 'embedding', `Batch failed: all ${rows.length} items`, {
        count: rows.length,
        errors: failed.map(f => ({ id: f.id, error: f.error }))
      })
    } else {
      insertLog('info', 'embedding', `Embedded ${rows.length} thought(s)`, {
        count: rows.length,
        durationMs: 0
      })
    }

    consecutiveFailures = failed.length === rows.length ? consecutiveFailures + 1 : 0
    const newBackoff = consecutiveFailures >= MAX_CONSECUTIVE_FAILURES ? Math.min(currentBackoff * 2, 64) : 1
    if (newBackoff !== currentBackoff) {
      currentBackoff = newBackoff
      if (currentBackoff > 1) {
        console.error(
          `[embedder] all ${rows.length} items failed (${consecutiveFailures}/${MAX_CONSECUTIVE_FAILURES}), backing off to ${currentBackoff}x interval`
        )
        insertLog('warning', 'embedding', `Backing off to ${currentBackoff}x interval`, {
          backoff: currentBackoff,
          consecutiveFailures
        })
        resetExtractor()
      }
      reschedule()
    }
    resetIdleTimer()
  } catch (err) {
    consecutiveFailures++
    const msg = err instanceof Error ? err.message : String(err)
    console.error(`[embedder] batch failed (${consecutiveFailures}/${MAX_CONSECUTIVE_FAILURES}):`, err)
    insertLog('error', 'embedding', `Batch failed: ${msg}`, {
      error: msg,
      consecutiveFailures
    })
    if (consecutiveFailures >= MAX_CONSECUTIVE_FAILURES) {
      currentBackoff = Math.min(currentBackoff * 2, 64)
      consecutiveFailures = 0
      console.error(`[embedder] too many failures, backing off to ${currentBackoff}x interval`)
      insertLog('warning', 'embedding', `Backing off to ${currentBackoff}x interval`, {
        backoff: currentBackoff,
        consecutiveFailures
      })
      resetExtractor()
      reschedule()
    }
  }
}

async function processSweep(): Promise<void> {
  try {
    const orphans = sweepOrphanedThoughts()
    if (orphans.length > 0) {
      // Re-queue orphans and let the next regular batch pick them up
      const db = getDb()
      const insert = db.prepare('INSERT OR IGNORE INTO pending_embeddings (thought_id, created_at) VALUES (?, ?)')
      const tx = db.transaction(() => {
        for (const row of orphans) insert.run(row.id, new Date().toISOString())
      })
      tx()
      console.log(`[embedder] sweep: re-queued ${orphans.length} orphaned thought(s)`)
      insertLog('info', 'embedding', `Sweep requeued ${orphans.length} thought(s)`, {
        count: orphans.length,
        ids: orphans.map(o => o.id)
      })
    }
    const gitOrphans = sweepOrphanedGitCommits()
    if (gitOrphans.length > 0) {
      const db = getDb()
      const insert = db.prepare('INSERT OR IGNORE INTO pending_git_embeddings (commit_id, created_at) VALUES (?, ?)')
      const tx = db.transaction(() => {
        for (const row of gitOrphans) insert.run(row.id, new Date().toISOString())
      })
      tx()
      console.log(`[embedder] sweep: re-queued ${gitOrphans.length} orphaned git commit(s)`)
      insertLog('info', 'embedding', `Sweep requeued ${gitOrphans.length} git commit(s)`, {
        count: gitOrphans.length,
        ids: gitOrphans.map(o => o.id)
      })
    }
  } catch (err) {
    console.error('[embedder] sweep failed:', err)
    insertLog('error', 'embedding', 'Sweep failed', {
      error: err instanceof Error ? err.message : String(err)
    })
  }
}

function startWorker(): void {
  if (pollTimer) return
  processBatch()
  processCommitBatch()
  pollTimer = setInterval(() => {
    void processBatch()
    void processCommitBatch()
  }, config.embedder.pollIntervalMs)
  sweepTimer = setInterval(processSweep, SWEEP_INTERVAL_MS)
}

// Git commit queue (issue #197) — mirrors the thought queue with its own
// failure counter; a stuck commit stream must not back off thought embedding.
let commitFailures = 0

async function processCommitBatch(): Promise<void> {
  try {
    const db = getDb()
    const rows = findPendingGitEmbeddings(db, BATCH_SIZE)
    if (rows.length === 0) {
      commitFailures = 0
      return
    }
    const embeddings = await generateEmbeddings(rows.map(r => r.content))
    const succeeded: string[] = []
    const failed: { id: string; error: string }[] = []
    for (let i = 0; i < rows.length; i++) {
      try {
        insertGitEmbedding(db, rows[i].id, embeddings[i])
        succeeded.push(rows[i].id)
      } catch (err) {
        failed.push({ id: rows[i].id, error: err instanceof Error ? err.message : String(err) })
      }
    }
    if (succeeded.length > 0) deleteGitQueueItems(db, succeeded)
    for (const f of failed) handleFailedGitItem(db, f.id, f.error)
    insertLog(
      failed.length > 0 ? 'warning' : 'info',
      'embedding',
      `Git commits batch: ${succeeded.length} ok, ${failed.length} failed`,
      {
        count: rows.length,
        failedCount: failed.length
      }
    )
    commitFailures = failed.length === rows.length ? commitFailures + 1 : 0
  } catch (err) {
    commitFailures++
    insertLog('error', 'embedding', `Commit batch failed (${commitFailures}):`, {
      error: err instanceof Error ? err.message : String(err)
    })
  }
}

process.on('message', async (raw: unknown) => {
  const message = raw as { type?: string; id?: string; method?: string; params?: { text?: string; texts?: string[] } }
  if (message.type === 'shutdown') {
    console.log('[embedder] shutdown requested, exiting')
    if (pollTimer) clearInterval(pollTimer)
    if (sweepTimer) clearInterval(sweepTimer)
    resetExtractor()
    process.exit(0)
    return
  }
  if (message.type === 'request') {
    resetIdleTimer()
    try {
      if (message.method === 'embed') {
        const embedding = await generateEmbedding(message.params?.text ?? '')
        process.send?.({
          type: 'result',
          id: message.id,
          embedding: Array.from(embedding)
        })
      } else if (message.method === 'embed_batch') {
        const embeddings = await generateEmbeddings(message.params?.texts ?? [])
        process.send?.({
          type: 'result',
          id: message.id,
          embedding: embeddings.map(e => Array.from(e))
        })
      }
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err)
      process.send?.({ type: 'error', id: message.id, error: msg })
    }
  }
})

initDb()
console.log('[embedder] checking model files...')
insertLog('debug', 'embedding', 'Embedder process started, validating model', {
  model: config.embedder.model,
  cacheDir: config.embedder.cacheDir
})
await ensureModelFiles(config.embedder.cacheDir, config.embedder.model)
console.log('[embedder] model validated, starting worker')
startWorker()
resetIdleTimer()
process.send?.({ type: 'ready' })
