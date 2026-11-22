import type { Database } from 'bun:sqlite'
import { config } from '../config'
import { getDb } from '../db'
import { closeDb, initDb, openDatabase } from '../db/init'
import { insertLog } from '../logging'
import { generateEmbeddings, resetExtractor } from './model'
import { ensureModelFiles } from './model-validator'
import {
  CONTENT_CHANGED_REASON,
  deleteEmbeddedFromQueue,
  findPendingEmbeddings,
  handleFailedItem,
  hasPendingEmbeddings,
  insertEmbedding,
  requeueEmbeddings,
  sweepOrphanedThoughts
} from '../db/pending-embeddings'
import { handleEmbedderRequest } from './handle-request'
import { EMBEDDER_IPC_PROTOCOL_VERSION, type IpcMessage } from './ipc-protocol'
import { type EmbeddingRow, type FailedRow, type RowOutcome, classifyBatch } from './batch'
import { batchWorkerEnabled, readEmbedderUsers } from './spawn-scope'
import { createIntervalJob } from '../interval-job'

const BATCH_SIZE = config.embedder.batchSize
const MAX_CONSECUTIVE_FAILURES = 5
const MAX_BACKOFF = 64
const SWEEP_INTERVAL_MS = 60 * 60 * 1000

interface DbEntry {
  id: string
  db: Database | null
  dbPath?: string
  nextPollAt: number
}

function openAllDbs(): DbEntry[] {
  const assigned = readEmbedderUsers()
  if (assigned) return assigned.map(u => ({ id: u.id, db: null, dbPath: u.dbPath, nextPollAt: 0 }))
  if (Array.isArray(config.users) && config.users.length > 0) {
    return config.users.map(u => ({ id: u.id, db: null, dbPath: u.dbPath, nextPollAt: 0 }))
  }
  initDb()
  const db = getDb()
  return [{ id: 'default', db, nextPollAt: 0 }]
}

// A parent that delegates background jobs spawns this process for on-demand requests only, so it
// holds no database handles and never drains a user queue on its own.
const batchWorker = batchWorkerEnabled()
const entries: DbEntry[] = batchWorker ? openAllDbs() : []

const consecutiveFailuresByDb: number[] = entries.map(() => 0)
const currentBackoffByDb: number[] = entries.map(() => 1)

let idleTimer: ReturnType<typeof setTimeout> | null = null
let batchInFlight = false
let dbStartIndex = 0

function clearTimers(): void {
  if (idleTimer) {
    clearTimeout(idleTimer)
    idleTimer = null
  }
  void pollJob.stop()
  void sweepJob.stop()
}

function closeAllDbs(): void {
  closeDb()
  for (const e of entries) {
    try {
      e.db?.close(true)
    } catch {}
  }
}

function resetIdleTimer() {
  if (idleTimer) clearTimeout(idleTimer)
  if (config.embedder.precache || config.embedder.idleTimeoutMs <= 0) {
    idleTimer = null
    return
  }
  idleTimer = setTimeout(() => {
    insertLog('info', 'embedding', 'Model unloaded (idle)', {
      idleMinutes: config.embedder.idleTimeoutMs / 60000
    })
    process.send?.({ type: 'exiting' })
    clearTimers()
    resetExtractor()
    closeAllDbs()
    process.exit(0)
  }, config.embedder.idleTimeoutMs)
}

function storeRow(
  db: Database,
  row: EmbeddingRow,
  embedding: Float32Array
): RowOutcome | FailedRow {
  try {
    return insertEmbedding(db, row.id, embedding, row.contentHash) ? 'stored' : 'skipped'
  } catch (err) {
    return { id: row.id, error: err instanceof Error ? err.message : String(err) }
  }
}

async function processOneDb(idx: number): Promise<boolean> {
  const entry = entries[idx]
  let didWork = false
  try {
    if (!entry.db) entry.db = openDatabase({ dbPath: entry.dbPath })
    const db = entry.db
    const rows = findPendingEmbeddings(db, BATCH_SIZE)
    if (rows.length === 0) {
      consecutiveFailuresByDb[idx] = 0
      if (currentBackoffByDb[idx] !== 1) {
        currentBackoffByDb[idx] = 1
      }
      return false
    }
    didWork = true
    const startedAt = Date.now()

    // The model resolves one vector per row or throws, so the payload length always matches.
    const embeddings = await generateEmbeddings(rows.map(r => r.content))
    const { succeeded, failed, contentChanged } = classifyBatch(rows, (row, i) =>
      storeRow(db, row, embeddings[i])
    )

    for (const f of failed) handleFailedItem(db, f.id, f.error)
    for (const id of contentChanged) handleFailedItem(db, id, CONTENT_CHANGED_REASON)
    if (succeeded.length > 0) {
      const stored = new Set(succeeded)
      deleteEmbeddedFromQueue(
        db,
        rows.filter(r => stored.has(r.id))
      )
    }

    if (failed.length > 0 && succeeded.length > 0) {
      insertLog(
        'warning',
        'embedding',
        `${failed.length} of ${rows.length} thought(s) failed, requeued`,
        {
          db: entry.id,
          failedCount: failed.length,
          total: rows.length,
          errors: failed.map(f => ({ id: f.id, error: f.error }))
        }
      )
    } else if (failed.length === rows.length) {
      insertLog('error', 'embedding', `Batch failed: all ${rows.length} items`, {
        db: entry.id,
        count: rows.length,
        errors: failed.map(f => ({ id: f.id, error: f.error }))
      })
    } else if (contentChanged.length === rows.length) {
      insertLog(
        'warning',
        'embedding',
        `Batch skipped: all ${rows.length} thought(s) changed content mid-batch, requeued`,
        {
          db: entry.id,
          skippedCount: contentChanged.length,
          total: rows.length,
          reason: CONTENT_CHANGED_REASON,
          ids: contentChanged
        }
      )
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
        durationMs: Date.now() - startedAt
      })
    }

    const allFailed = failed.length === rows.length
    consecutiveFailuresByDb[idx] = allFailed ? consecutiveFailuresByDb[idx] + 1 : 0
    if (!allFailed) {
      currentBackoffByDb[idx] = 1
    } else if (consecutiveFailuresByDb[idx] >= MAX_CONSECUTIVE_FAILURES) {
      const failures = consecutiveFailuresByDb[idx]
      consecutiveFailuresByDb[idx] = 0
      const backoff = Math.min(currentBackoffByDb[idx] * 2, MAX_BACKOFF)
      if (backoff !== currentBackoffByDb[idx]) {
        currentBackoffByDb[idx] = backoff
        insertLog('warning', 'embedding', `Backing off to ${backoff}x interval`, {
          db: entry.id,
          backoff,
          consecutiveFailures: failures
        })
        resetExtractor()
      }
    }
    return true
  } catch (err) {
    consecutiveFailuresByDb[idx]++
    const failures = consecutiveFailuresByDb[idx]
    const msg = err instanceof Error ? err.message : String(err)
    insertLog('error', 'embedding', `Batch failed: ${msg}`, {
      db: entry.id,
      error: msg,
      consecutiveFailures: failures
    })
    if (failures >= MAX_CONSECUTIVE_FAILURES) {
      const backoff = Math.min(currentBackoffByDb[idx] * 2, MAX_BACKOFF)
      consecutiveFailuresByDb[idx] = 0
      if (backoff !== currentBackoffByDb[idx]) {
        currentBackoffByDb[idx] = backoff
        insertLog('warning', 'embedding', `Backing off to ${backoff}x interval`, {
          db: entry.id,
          backoff,
          consecutiveFailures: failures
        })
        resetExtractor()
      }
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
      const now = Date.now()
      if (now < entries[idx].nextPollAt) continue
      const w = await processOneDb(idx)
      entries[idx].nextPollAt = now + config.embedder.pollIntervalMs * currentBackoffByDb[idx]
      if (w) didWork = true
    }
    if (didWork) resetIdleTimer()
  } finally {
    batchInFlight = false
  }
}

function processSweep(): void {
  const order = entries.map((_, i) => (dbStartIndex + i) % entries.length)
  for (const idx of order) {
    const entry = entries[idx]
    const db = entry.db
    if (!db) continue
    try {
      if (hasPendingEmbeddings(db)) continue
      const orphans = sweepOrphanedThoughts(db, BATCH_SIZE)
      if (orphans.length > 0) {
        requeueEmbeddings(
          db,
          orphans.map(o => o.id)
        )
        insertLog('info', 'embedding', `Sweep requeued ${orphans.length} thought(s)`, {
          db: entry.id,
          count: orphans.length,
          ids: orphans.map(o => o.id)
        })
      }
    } catch (err) {
      insertLog('error', 'embedding', 'Sweep failed', {
        db: entry.id,
        error: err instanceof Error ? err.message : String(err)
      })
    }
  }
}

const pollJob = createIntervalJob(
  {
    name: 'embedder-poll',
    intervalMs: config.embedder.pollIntervalMs,
    unref: false,
    onError: err => {
      insertLog('error', 'embedding', 'Embedder poll loop failed', {
        error: err instanceof Error ? err.message : String(err)
      })
    }
  },
  processBatch
)

const sweepJob = createIntervalJob(
  {
    name: 'embedder-sweep',
    intervalMs: SWEEP_INTERVAL_MS,
    unref: false,
    onError: err => {
      insertLog('error', 'embedding', 'Embedder sweep loop failed', {
        error: err instanceof Error ? err.message : String(err)
      })
    }
  },
  processSweep
)

function startWorker(): void {
  pollJob.start()
  sweepJob.start()
}

process.on('message', async (raw: unknown) => {
  const message = raw as IpcMessage
  if (message.type === 'shutdown') {
    insertLog('info', 'embedding', 'Shutdown requested, exiting')
    clearTimers()
    resetExtractor()
    closeAllDbs()
    process.exit(0)
    return
  }
  if (message.type === 'request') {
    resetIdleTimer()
    await handleEmbedderRequest(message, reply => process.send?.(reply))
  }
})

insertLog('debug', 'embedding', 'Embedder process started, validating model', {
  model: config.embedder.model,
  dtype: config.embedder.dtype,
  cacheDir: config.embedder.cacheDir
})
await ensureModelFiles(config.embedder.cacheDir, config.embedder.model, config.embedder.dtype)
if (batchWorker) {
  startWorker()
} else {
  insertLog('info', 'embedding', 'Queue worker disabled: the parent delegates background jobs')
}
resetIdleTimer()
process.send?.({ type: 'ready', protocol: EMBEDDER_IPC_PROTOCOL_VERSION })
