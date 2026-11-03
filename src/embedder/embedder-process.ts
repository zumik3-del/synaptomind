import type { Database } from 'bun:sqlite'
import { config } from '../config'
import { getDb } from '../db/container'
import { closeDb, initDb, openDatabase } from '../db/init'
import { insertLog } from '../logging'
import { generateEmbeddings, resetExtractor } from './model'
import { ensureModelFiles } from './model-validator'
import {
  CONTENT_CHANGED_REASON,
  deleteFromQueue,
  findPendingEmbeddings,
  handleFailedItem,
  insertEmbedding,
  requeueEmbeddings,
  sweepOrphanedThoughts
} from '../db/pending-embeddings'
import { handleEmbedderRequest } from './handle-request'
import type { IpcMessage } from './ipc-protocol'
import { type EmbeddingRow, type FailedRow, type RowOutcome, classifyBatch } from './batch'

const BATCH_SIZE = config.embedder.batchSize
const MAX_CONSECUTIVE_FAILURES = 5
const SWEEP_INTERVAL_MS = 5 * 60 * 1000 // 5 minutes

interface DbEntry {
  id: string
  db: Database
}

function openAllDbs(): DbEntry[] {
  if (Array.isArray(config.users) && config.users.length > 0) {
    return config.users.map(u => ({ id: u.id, db: openDatabase({ dbPath: u.dbPath }) }))
  }
  // Legacy single-user mode: keep the singleton published so closeDb() works.
  initDb()
  const db = getDb()
  return [{ id: 'default', db }]
}

const entries: DbEntry[] = openAllDbs()

// Per-DB backoff state (parallel to `entries`).
const consecutiveFailuresByDb: number[] = entries.map(() => 0)
const currentBackoffByDb: number[] = entries.map(() => 1)

let pollTimer: ReturnType<typeof setInterval> | null = null
let sweepTimer: ReturnType<typeof setInterval> | null = null
let idleTimer: ReturnType<typeof setTimeout> | null = null
let batchInFlight = false
let dbStartIndex = 0
let globalBackoff = 1

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
    if (idleTimer) clearTimeout(idleTimer)
    if (pollTimer) clearInterval(pollTimer)
    if (sweepTimer) clearInterval(sweepTimer)
    resetExtractor()
    for (const e of entries) {
      try { e.db.close(true) } catch { /* ignore */ }
    }
    closeDb()
    process.exit(0)
  }, config.embedder.idleTimeoutMs)
}

function recomputeGlobalBackoff() {
  const next = currentBackoffByDb.reduce((a, b) => Math.max(a, b), 1)
  if (next === globalBackoff) return
  globalBackoff = next
  if (pollTimer) {
    clearInterval(pollTimer)
    pollTimer = null
  }
  pollTimer = setInterval(() => {
    void processBatch()
  }, config.embedder.pollIntervalMs * globalBackoff)
}

/** Store one row through `insertEmbedding` and map its outcome for `classifyBatch`. */
function storeRow(db: Database, row: EmbeddingRow, embedding: Float32Array): RowOutcome | FailedRow {
  try {
    return insertEmbedding(db, row.id, embedding, row.contentHash) ? 'stored' : 'skipped'
  } catch (err) {
    return { id: row.id, error: err instanceof Error ? err.message : String(err) }
  }
}

async function processOneDb(idx: number): Promise<boolean> {
  const entry = entries[idx]
  const db = entry.db
  let didWork = false
  try {
    const rows = findPendingEmbeddings(db, BATCH_SIZE)
    if (rows.length === 0) {
      consecutiveFailuresByDb[idx] = 0
      if (currentBackoffByDb[idx] !== 1) {
        currentBackoffByDb[idx] = 1
        recomputeGlobalBackoff()
      }
      return false
    }
    didWork = true

    const embeddings = await generateEmbeddings(rows.map(r => r.content))
    const { succeeded, failed, contentChanged } = classifyBatch(rows, (row, i) => storeRow(db, row, embeddings[i]))

    for (const f of failed) handleFailedItem(db, f.id, f.error)
    for (const id of contentChanged) handleFailedItem(db, id, CONTENT_CHANGED_REASON)
    if (succeeded.length > 0) deleteFromQueue(db, succeeded)

    if (failed.length > 0 && succeeded.length > 0) {
      insertLog('warning', 'embedding', `${failed.length} of ${rows.length} thought(s) failed, requeued`, {
        db: entry.id,
        failedCount: failed.length,
        total: rows.length,
        errors: failed.map(f => ({ id: f.id, error: f.error }))
      })
    } else if (failed.length === rows.length) {
      insertLog('error', 'embedding', `Batch failed: all ${rows.length} items`, {
        db: entry.id,
        count: rows.length,
        errors: failed.map(f => ({ id: f.id, error: f.error }))
      })
    } else if (contentChanged.length === rows.length) {
      insertLog('warning', 'embedding', `Batch skipped: all ${rows.length} thought(s) changed content mid-batch, requeued`, {
        db: entry.id,
        skippedCount: contentChanged.length,
        total: rows.length,
        reason: CONTENT_CHANGED_REASON,
        ids: contentChanged
      })
    } else if (contentChanged.length > 0) {
      insertLog(
        'warning',
        'embedding',
        `${contentChanged.length} of ${rows.length} thought(s) changed content mid-batch, requeued`,
        {
          db: entry.id,
          skippedCount: contentChanged.length,
          storedCount: succeeded.length,
          failedCount: failed.length,
          total: rows.length,
          reason: CONTENT_CHANGED_REASON,
          ids: contentChanged
        }
      )
    } else {
      insertLog('info', 'embedding', `Embedded ${rows.length} thought(s)`, {
        db: entry.id,
        count: rows.length,
        durationMs: 0
      })
    }

    // Backoff tracks EMBEDDER health, so a content change is not counted.
    consecutiveFailuresByDb[idx] = failed.length === rows.length ? consecutiveFailuresByDb[idx] + 1 : 0
    const newBackoff =
      consecutiveFailuresByDb[idx] >= MAX_CONSECUTIVE_FAILURES
        ? Math.min(currentBackoffByDb[idx] * 2, 64)
        : 1
    if (newBackoff !== currentBackoffByDb[idx]) {
      currentBackoffByDb[idx] = newBackoff
      if (currentBackoffByDb[idx] > 1) {
        console.error(
          `[embedder] all ${rows.length} items failed (${consecutiveFailuresByDb[idx]}/${MAX_CONSECUTIVE_FAILURES}), backing off to ${currentBackoffByDb[idx]}x interval`
        )
        insertLog('warning', 'embedding', `Backing off to ${currentBackoffByDb[idx]}x interval`, {
          db: entry.id,
          backoff: currentBackoffByDb[idx],
          consecutiveFailures: consecutiveFailuresByDb[idx]
        })
        resetExtractor()
      }
      recomputeGlobalBackoff()
    }
    return true
  } catch (err) {
    consecutiveFailuresByDb[idx]++
    const msg = err instanceof Error ? err.message : String(err)
    console.error(`[embedder] batch failed (${consecutiveFailuresByDb[idx]}/${MAX_CONSECUTIVE_FAILURES}):`, err)
    insertLog('error', 'embedding', `Batch failed: ${msg}`, {
      db: entry.id,
      error: msg,
      consecutiveFailures: consecutiveFailuresByDb[idx]
    })
    if (consecutiveFailuresByDb[idx] >= MAX_CONSECUTIVE_FAILURES) {
      currentBackoffByDb[idx] = Math.min(currentBackoffByDb[idx] * 2, 64)
      consecutiveFailuresByDb[idx] = 0
      console.error(`[embedder] too many failures, backing off to ${currentBackoffByDb[idx]}x interval`)
      insertLog('warning', 'embedding', `Backing off to ${currentBackoffByDb[idx]}x interval`, {
        db: entry.id,
        backoff: currentBackoffByDb[idx],
        consecutiveFailures: consecutiveFailuresByDb[idx]
      })
      resetExtractor()
      recomputeGlobalBackoff()
    }
    return didWork
  }
}

async function processBatch(): Promise<void> {
  if (batchInFlight) return
  if (entries.length === 0) return
  batchInFlight = true
  try {
    const order = entries.map((_, i) => (dbStartIndex + i) % entries.length)
    dbStartIndex = (dbStartIndex + 1) % entries.length
    let didWork = false
    for (const idx of order) {
      const w = await processOneDb(idx)
      if (w) didWork = true
    }
    if (didWork) resetIdleTimer()
  } finally {
    batchInFlight = false
  }
}

async function processSweep(): Promise<void> {
  const order = entries.map((_, i) => (dbStartIndex + i) % entries.length)
  for (const idx of order) {
    const entry = entries[idx]
    const db = entry.db
    try {
      const orphans = sweepOrphanedThoughts(db, BATCH_SIZE)
      if (orphans.length > 0) {
        requeueEmbeddings(
          db,
          orphans.map(o => o.id)
        )
        console.log(`[embedder] sweep: re-queued ${orphans.length} orphaned thought(s)`)
        insertLog('info', 'embedding', `Sweep requeued ${orphans.length} thought(s)`, {
          db: entry.id,
          count: orphans.length,
          ids: orphans.map(o => o.id)
        })
      }
    } catch (err) {
      console.error('[embedder] sweep failed:', err)
      insertLog('error', 'embedding', 'Sweep failed', {
        db: entry.id,
        error: err instanceof Error ? err.message : String(err)
      })
    }
  }
}

function startWorker(): void {
  if (pollTimer) return
  processBatch()
  pollTimer = setInterval(() => {
    void processBatch()
  }, config.embedder.pollIntervalMs)
  sweepTimer = setInterval(processSweep, SWEEP_INTERVAL_MS)
}

process.on('message', async (raw: unknown) => {
  const message = raw as IpcMessage
  if (message.type === 'shutdown') {
    console.log('[embedder] shutdown requested, exiting')
    if (idleTimer) clearTimeout(idleTimer)
    if (pollTimer) clearInterval(pollTimer)
    if (sweepTimer) clearInterval(sweepTimer)
    resetExtractor()
    for (const e of entries) {
      try { e.db.close(true) } catch { /* ignore */ }
    }
    closeDb()
    process.exit(0)
    return
  }
  if (message.type === 'request') {
    resetIdleTimer()
    await handleEmbedderRequest(message, reply => process.send?.(reply))
  }
})

// initDb already called inside openAllDbs() for legacy mode.
console.log('[embedder] checking model files...')
insertLog('debug', 'embedding', 'Embedder process started, validating model', {
  model: config.embedder.model,
  dtype: config.embedder.dtype,
  cacheDir: config.embedder.cacheDir
})
await ensureModelFiles(config.embedder.cacheDir, config.embedder.model, config.embedder.dtype)
console.log('[embedder] model validated, starting worker')
startWorker()
resetIdleTimer()
process.send?.({ type: 'ready' })