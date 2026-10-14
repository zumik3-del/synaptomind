import type { Database } from 'bun:sqlite'
import { config } from '../config'
import { getDb } from '../db/container'
import { initDb } from '../db/init'
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
import { type EmbeddingRow, type FailedRow, type RowOutcome, classifyBatch } from './batch'

const BATCH_SIZE = config.embedder.batchSize
const MAX_CONSECUTIVE_FAILURES = 5
const SWEEP_INTERVAL_MS = 5 * 60 * 1000 // 5 minutes
let pollTimer: ReturnType<typeof setInterval> | null = null
let sweepTimer: ReturnType<typeof setInterval> | null = null
let idleTimer: ReturnType<typeof setTimeout> | null = null
let consecutiveFailures = 0
let currentBackoff = 1
let batchInFlight = false

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

function reschedule() {
  if (pollTimer) {
    clearInterval(pollTimer)
    pollTimer = null
  }
  const interval = config.embedder.pollIntervalMs * currentBackoff
  pollTimer = setInterval(processBatch, interval)
}

/** Store one row through `insertEmbedding` and map its outcome for `classifyBatch`. */
function storeRow(db: Database, row: EmbeddingRow, embedding: Float32Array): RowOutcome | FailedRow {
  try {
    return insertEmbedding(db, row.id, embedding, row.contentHash) ? 'stored' : 'skipped'
  } catch (err) {
    return { id: row.id, error: err instanceof Error ? err.message : String(err) }
  }
}

async function processBatch(): Promise<void> {
  if (batchInFlight) return
  batchInFlight = true
  try {
    const db = getDb()
    const rows = findPendingEmbeddings(db, BATCH_SIZE)
    if (rows.length === 0) {
      consecutiveFailures = 0
      if (currentBackoff !== 1) {
        currentBackoff = 1
        reschedule()
      }
      return
    }

    const embeddings = await generateEmbeddings(rows.map(r => r.content))
    const { succeeded, failed, contentChanged } = classifyBatch(rows, (row, i) => storeRow(db, row, embeddings[i]))

    for (const f of failed) handleFailedItem(db, f.id, f.error)
    // A skipped row keeps its queue row (`deleteFromQueue` below only ever sees
    // `succeeded`), so the worker retries it on the next poll against whatever
    // the content is by then. The attempt is still recorded, so a row that keeps
    // changing stays distinguishable from one that was never tried.
    for (const id of contentChanged) handleFailedItem(db, id, CONTENT_CHANGED_REASON)
    if (succeeded.length > 0) deleteFromQueue(db, succeeded)

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
    } else if (contentChanged.length === rows.length) {
      insertLog('warning', 'embedding', `Batch skipped: all ${rows.length} thought(s) changed content mid-batch, requeued`, {
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
        count: rows.length,
        durationMs: 0
      })
    }

    // Backoff tracks EMBEDDER health, so a content change is not counted: a
    // read-modify-write burst that touches every row in each batch would
    // otherwise look like a mass embedder failure and multiply the poll
    // interval, delaying the very retries that resolve it.
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
  } finally {
    batchInFlight = false
  }
}

async function processSweep(): Promise<void> {
  try {
    const db = getDb()
    const orphans = sweepOrphanedThoughts(db, BATCH_SIZE)
    if (orphans.length > 0) {
      // Re-queue orphans and let the next regular batch pick them up
      requeueEmbeddings(
        db,
        orphans.map(o => o.id)
      )
      console.log(`[embedder] sweep: re-queued ${orphans.length} orphaned thought(s)`)
      insertLog('info', 'embedding', `Sweep requeued ${orphans.length} thought(s)`, {
        count: orphans.length,
        ids: orphans.map(o => o.id)
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
  pollTimer = setInterval(() => {
    void processBatch()
  }, config.embedder.pollIntervalMs)
  sweepTimer = setInterval(processSweep, SWEEP_INTERVAL_MS)
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
    await handleEmbedderRequest(message, reply => process.send?.(reply))
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
