import { config } from '../config'
import { getDb } from '../db/container'
import { initDb } from '../db/init'
import { insertLog } from '../logging'
import { generateEmbeddings, resetExtractor } from './model'
import { ensureModelFiles } from './model-validator'
import { deleteFromQueue, findPendingEmbeddings, handleFailedItem, insertEmbedding, sweepOrphanedThoughts } from './queue'
import { handleEmbedderRequest } from './handle-request'

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

async function processBatch(): Promise<void> {
  if (batchInFlight) return
  batchInFlight = true
  try {
    const rows = findPendingEmbeddings(BATCH_SIZE)
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
        insertEmbedding(row.id, embeddings[i], row.contentHash)
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
  } finally {
    batchInFlight = false
  }
}

async function processSweep(): Promise<void> {
  try {
    const orphans = sweepOrphanedThoughts(BATCH_SIZE)
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
