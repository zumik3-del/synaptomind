import { Database } from 'bun:sqlite'
import { existsSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, expect, mock, test } from 'bun:test'

/**
 * Task #1573 — the batch loop of #1572 driven FOR REAL.
 *
 * `embedder-process.ts` is a side-effect module: importing it runs `initDb()`,
 * validates the model and starts the poll worker. The invariant "only
 * `succeeded` reaches `deleteFromQueue`" (and the skip log / backoff decisions)
 * therefore lives behind that import, and `src/embedder/batch.test.ts` can only
 * mirror the composition. This suite drives the shipped loop instead:
 *
 *  · `../db/init` → `:memory:` database (the worker's own `initDb()` call),
 *  · `./model` + `./model-validator` → no model download, and the embed step is
 *    the deterministic mid-batch edit window,
 *  · `../db/pending-embeddings` → real queue functions with `insertEmbedding`
 *    able to throw (the all-failed leg) and a spy on `deleteFromQueue` that
 *    records the ids the SHIPPED loop passes, then performs the real delete.
 *
 * It runs in a child bun process (see `embedder-batch-loop.test.ts`): bun's
 * `mock.module` leaks through `export *`, and this file mocks four modules.
 *
 * Excluded from the default `bun test` glob (`*.suite.ts`).
 */

// ── environment: `config` is read at import time, so every knob must be set
// before the first dynamic import ────────────────────────────────────────────
const scratch = mkdtempSync(join(tmpdir(), 'synaptomind-batch-loop-'))
const logDbPath = join(scratch, 'logs.db')
process.env.SYNAPTOMIND_LOG_DB_PATH = logDbPath
// A 5 ms poll makes "six consecutive batches" observable in milliseconds; the
// production interval (7 s) would make this suite take minutes.
process.env.SYNAPTOMIND_EMBEDDER_POLL_INTERVAL = '5'
// Precache mode keeps the worker resident and skips the idle-unload timer.
process.env.SYNAPTOMIND_EMBEDDER_PRECACHE = 'true'
process.env.SYNAPTOMIND_EMBEDDER_BATCH_SIZE = '8'
// Safety net: if the `../db/init` mock below ever fails to apply, the worker
// opens THIS throwaway file instead of a real database path.
process.env.SYNAPTOMIND_DB_PATH = join(scratch, 'never-used.db')
// Pinned rather than inherited: the dtype the shipped process forwards to
// `ensureModelFiles` is asserted below, and an ambient override would make that
// assertion depend on the caller's shell.
process.env.SYNAPTOMIND_EMBEDDER_DTYPE = 'q8'

// ── real modules, snapshotted before the mocks replace them ──────────────────
// Plain-object snapshots, not namespaces: `mock.module` rewrites the namespace
// a mocked specifier already handed out, so reading through `realInit.initDb` /
// `realQueue.insertEmbedding` after mocking would call the mock again.
const realInitFns = { ...(await import('../db/init')) }
const realQueueFns = { ...(await import('../db/pending-embeddings')) }
const { getDb } = await import('../db/container')
const { config } = await import('../config')
const { seedThought } = await import('../test/helpers')

// ── mocks ────────────────────────────────────────────────────────────────────
let dbBootstrapped = false
/** The worker's own `initDb()` lands on an in-memory, migrated test database. */
function bootstrapDb(): void {
  if (dbBootstrapped) return
  dbBootstrapped = true
  realInitFns.initDb({ dbPath: ':memory:', runMigrations: true })
}
mock.module('../db/init', () => ({ ...realInitFns, initDb: bootstrapDb }))

const control = {
  /** Runs inside the embed step: the deterministic "content changed mid-batch" window. */
  edit: null as null | (() => void),
  /**
   * Make every store throw. Starts TRUE: the phase-A row is seeded before the
   * worker boots, and the boot batch itself must be the first all-failed batch —
   * with the flag false that first batch would store and delete the row, leaving
   * an empty queue and no failure to back off from.
   */
  storeThrows: true,
  /** Serve the worker an empty queue without touching the real one (freeze). */
  drainQueue: false
}

/** Identity marker slot 0 of the vector the stubbed embedder returns. */
const EMBED_MARKER = 55

function markerVector(): Float32Array {
  const v = new Float32Array(384)
  v[0] = EMBED_MARKER
  return v
}

mock.module('./model', () => ({
  generateEmbeddings: async (texts: string[]) => {
    control.edit?.()
    return texts.map(() => markerVector())
  },
  // `handle-request.ts` (the worker's IPC leg) imports the singular form too.
  generateEmbedding: async () => markerVector(),
  resetExtractor: () => {}
}))
/** The model call the SHIPPED process booted with (`embedder.dtype` wiring). */
interface EnsureModelCall {
  cacheDir: string
  model: string
  dtype: string
}

const ensureModelCalls: EnsureModelCall[] = []
mock.module('./model-validator', () => ({
  ensureModelFiles: async (cacheDir: string, model: string, dtype: string) => {
    ensureModelCalls.push({ cacheDir, model, dtype })
  }
}))

/** Ids the SHIPPED loop handed to `deleteFromQueue`, per call. */
const deleteCalls: string[][] = []
// The queue module moved to the db layer (task #1581): the mock specifier follows
// it, and every mock mirrors the db-first signature so the worker's `db` argument
// reaches the real function instead of being read as the first parameter.
mock.module('../db/pending-embeddings', () => ({
  ...realQueueFns,
  insertEmbedding: (db: Database, id: string, embedding: Float32Array, expectedHash: string) => {
    if (control.storeThrows) throw new Error('boom')
    return realQueueFns.insertEmbedding(db, id, embedding, expectedHash)
  },
  findPendingEmbeddings: (db: Database, limit: number) =>
    control.drainQueue ? [] : realQueueFns.findPendingEmbeddings(db, limit),
  deleteFromQueue: (db: Database, ids: string[]) => {
    deleteCalls.push([...ids])
    realQueueFns.deleteFromQueue(db, ids)
  }
}))

// ── timer capture so the suite can tear the worker down and exit ──────────────
const timers = new Set<ReturnType<typeof setInterval>>()
const realSetInterval = globalThis.setInterval
globalThis.setInterval = ((handler: () => void, timeout?: number) => {
  const timer = realSetInterval(handler, timeout)
  timers.add(timer)
  return timer
}) as typeof globalThis.setInterval

// ── fixture ─────────────────────────────────────────────────────────────────
bootstrapDb()
// vec_thoughts is a vec0 virtual table — v002 skips it on `:memory:` databases.
getDb().prepare('CREATE TABLE IF NOT EXISTS vec_thoughts (id TEXT PRIMARY KEY, embedding BLOB)').run()

/**
 * Seed a queued thought whose content and `content_hash` are written TOGETHER
 * (task #1572 gotcha: `seedThought` leaves the hash NULL, and the v035 trigger
 * records the row's CURRENT hash — a batch only skips when the hash diverges).
 */
function seedQueued(content: string, hash: string): string {
  const id = seedThought({ content })
  getDb().prepare('UPDATE thoughts SET content = ?, content_hash = ? WHERE id = ?').run(content, hash, id)
  return id
}

function queueRow(id: string): { attempts: number; is_error: number; last_error: string | null } | null {
  const found = getDb()
    .prepare('SELECT attempts, is_error, last_error FROM pending_embeddings WHERE thought_id = ?')
    .get(id) as { attempts: number; is_error: number; last_error: string | null } | undefined
  return found ?? null
}

function storedMarker(id: string): number | undefined {
  const stored = getDb().prepare('SELECT embedding FROM vec_thoughts WHERE id = ?').get(id) as
    | { embedding: Uint8Array }
    | undefined
  if (!stored) return undefined
  return new Float32Array(stored.embedding.buffer, stored.embedding.byteOffset, stored.embedding.byteLength / 4)[0]
}

interface LogRow {
  level: string
  type: string
  message: string
  metadata: string | null
}

/**
 * The worker's log store writes to the temp `logs.db`; read it back as an
 * operator would. One shared read connection: the probes below poll this in a
 * tight loop while the worker polls at 5 ms, and re-opening per probe would
 * stretch the wait past the row's retry budget.
 */
let logReader: Database | null = null
function logRows(): LogRow[] {
  if (!existsSync(logDbPath)) return []
  logReader ??= new Database(logDbPath)
  return logReader.prepare('SELECT level, type, message, metadata FROM logs ORDER BY created_at, id').all() as LogRow[]
}

const skipLogs = (): LogRow[] => logRows().filter(r => r.type === 'embedding' && r.message.includes('mid-batch'))
const backoffLogs = (): LogRow[] => logRows().filter(r => r.message.includes('Backing off'))

async function waitFor(what: string, probe: () => boolean, timeoutMs = 10_000): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (probe()) return
    await Bun.sleep(5)
  }
  throw new Error(`timed out after ${timeoutMs}ms waiting for ${what}`)
}

// ── phase A fixture: one row that always fails to store ──────────────────────
const failedId = seedQueued('failing content', 'hash-fail')

// ── boot the shipped worker ──────────────────────────────────────────────────
await import('./embedder-process')

afterAll(() => {
  for (const timer of timers) clearInterval(timer)
  logReader?.close()
  realInitFns.closeDb()
  rmSync(scratch, { recursive: true, force: true })
})

test('the shipped process validates the model with the configured dtype', () => {
  // `ensureModelFiles` runs during boot, before the worker's first batch, so at
  // least one call has already happened by the time this runs.
  expect(ensureModelCalls.length).toBeGreaterThanOrEqual(1)

  const call = ensureModelCalls[0]
  // The file the validator then demands (onnx/model_quantized.onnx for q8) is
  // only the file the LOADER opens if this argument really is the config dtype.
  expect(call.dtype).toBe(config.embedder.dtype)
  expect(call.dtype).toBe('q8')
  expect(call.model).toBe(config.embedder.model)
  expect(call.cacheDir).toBe(config.embedder.cacheDir)
})

test(
  'AC6 (real loop): an all-failed batch drives the backoff, and the store fault reaches handleFailedItem with its message',
  async () => {
    await waitFor('the all-failed backoff log', () => backoffLogs().length > 0)

    // AC1 through the REAL `storeRow`: the thrown message is carried into
    // `failed` and recorded on the queue row by `handleFailedItem`.
    const row = queueRow(failedId)
    expect(row?.last_error).toBe('boom')
    expect(row?.attempts).toBeGreaterThanOrEqual(5)

    const allFailedLog = logRows().find(r => r.type === 'embedding' && r.message.startsWith('Batch failed: all'))
    expect(allFailedLog).toBeDefined()
  },
  20_000
)

test(
  'AC2/AC5/AC6/AC8 (real loop): a skipped row never reaches deleteFromQueue, is logged, and does not advance the backoff',
  async () => {
    const backoffBefore = backoffLogs().length

    // Phase B fixture:
    //  · `stableId` keeps the hash its batch reads → stored, deleted, vector written;
    //  · `skipId` is edited inside every embed step → skipped on every batch.
    control.storeThrows = false
    getDb().prepare('DELETE FROM pending_embeddings WHERE thought_id = ?').run(failedId)
    const stableId = seedQueued('stable content', 'hash-stable')
    let editSeq = 0
    const skipId = seedQueued('skip content', 'hash-skip-0')
    control.edit = () => {
      editSeq++
      getDb()
        .prepare('UPDATE thoughts SET content = ?, content_hash = ? WHERE id = ?')
        .run(`skip content ${editSeq}`, `hash-skip-${editSeq}`, skipId)
    }

    await waitFor('six mid-batch-skip batches', () => skipLogs().length >= 6)
    // Freeze the worker (empty queue from the worker's point of view) so the
    // snapshot below is stable.
    control.drainQueue = true
    await Bun.sleep(20)

    // AC8 — the success path still deletes the queue row and writes the vector.
    expect(deleteCalls.flat()).toContain(stableId)
    expect(queueRow(stableId)).toBeNull()
    expect(storedMarker(stableId)).toBe(EMBED_MARKER)

    // AC2 — THE INVARIANT: the shipped loop never handed the skipped id to the
    // delete path, so its freshness signal survives…
    expect(deleteCalls.flat()).not.toContain(skipId)
    expect(skipLogs().length).toBeGreaterThanOrEqual(6)
    const skipped = queueRow(skipId)
    expect(skipped).not.toBeNull()
    // `attempts` is 1, not 6: every mid-batch edit fires the v035 trigger, whose
    // `INSERT OR REPLACE` re-creates the queue row and resets the counter, so the
    // recorded attempt means "skips since the last content change". What matters
    // is that an attempt IS recorded and the row stays retryable.
    expect(skipped?.attempts).toBeGreaterThanOrEqual(1)
    expect(skipped?.is_error).toBe(0)
    // AC5 — …the skip recorded an attempt carrying the shared reason…
    expect(skipped?.last_error).toBe(realQueueFns.CONTENT_CHANGED_REASON)

    // AC5 — …and the batch logged a warning carrying skippedCount/reason/ids.
    const skipRow = skipLogs().at(-1)!
    const metadata = JSON.parse(skipRow.metadata ?? '{}') as { skippedCount?: number; reason?: string; ids?: string[] }
    expect(skipRow.level).toBe('warning')
    expect(metadata.reason).toBe(realQueueFns.CONTENT_CHANGED_REASON)
    expect(metadata.skippedCount).toBeGreaterThanOrEqual(1)
    expect(metadata.ids).toContain(skipId)

    // AC6 — backoff tracks embedder health: six-plus all-skipped batches added
    // no backoff step, while the all-failed phase did.
    expect(backoffLogs().length).toBe(backoffBefore)
  },
  20_000
)
