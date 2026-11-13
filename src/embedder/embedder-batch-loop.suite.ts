import type { Database } from 'bun:sqlite'
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, expect, mock, test } from 'bun:test'

const scratch = mkdtempSync(join(tmpdir(), 'synaptomind-batch-loop-'))
const logFile = join(scratch, 'logs.jsonl')
process.env.SYNAPTOMIND_LOG_FILE = logFile
process.env.SYNAPTOMIND_LOG_FORMAT = 'json'
process.env.SYNAPTOMIND_EMBEDDER_POLL_INTERVAL = '5'
process.env.SYNAPTOMIND_EMBEDDER_PRECACHE = 'true'
process.env.SYNAPTOMIND_EMBEDDER_BATCH_SIZE = '8'
process.env.SYNAPTOMIND_DB_PATH = join(scratch, 'never-used.db')
process.env.SYNAPTOMIND_EMBEDDER_DTYPE = 'fp32'

// Plain-object snapshots, not namespaces: `mock.module` rewrites the namespace
// a mocked specifier already handed out, so reading through `realInit.initDb` /
// `realQueue.insertEmbedding` after mocking would call the mock again.
const realInitFns = { ...(await import('../db/init')) }
const realQueueFns = { ...(await import('../db/pending-embeddings')) }
const { getDb } = await import('../context/container')
const { config } = await import('../config')
const { seedThought } = await import('../test/helpers')

let dbBootstrapped = false
function bootstrapDb(): void {
  if (dbBootstrapped) return
  dbBootstrapped = true
  realInitFns.initDb({ dbPath: ':memory:', runMigrations: true })
}
mock.module('../db/init', () => ({ ...realInitFns, initDb: bootstrapDb }))

const control = {
  edit: null as null | (() => void),
  retireEdit: null as null | ((ids: string[]) => void),
  storeThrows: true,
  drainQueue: false
}

const EMBED_MARKER = 55

const embeddedTexts: string[] = []

function markerVector(): Float32Array {
  const v = new Float32Array(384)
  v[0] = EMBED_MARKER
  return v
}

mock.module('./model', () => ({
  generateEmbeddings: async (texts: string[]) => {
    control.edit?.()
    embeddedTexts.push(...texts)
    return texts.map(() => markerVector())
  },
  generateEmbedding: async () => markerVector(),
  resetExtractor: () => {}
}))
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

const deleteCalls: string[][] = []
const retireCalls: { id: string; contentHash: string }[] = []
mock.module('../db/pending-embeddings', () => ({
  ...realQueueFns,
  insertEmbedding: (db: Database, id: string, embedding: Float32Array, expectedHash: string) => {
    if (control.storeThrows) throw new Error('boom')
    return realQueueFns.insertEmbedding(db, id, embedding, expectedHash)
  },
  findPendingEmbeddings: (db: Database, limit: number) =>
    control.drainQueue ? [] : realQueueFns.findPendingEmbeddings(db, limit),
  deleteEmbeddedFromQueue: (db: Database, rows: { id: string; contentHash: string }[]) => {
    deleteCalls.push(rows.map(r => r.id))
    retireCalls.push(...rows.map(r => ({ id: r.id, contentHash: r.contentHash })))
    control.retireEdit?.(rows.map(r => r.id))
    realQueueFns.deleteEmbeddedFromQueue(db, rows)
  }
}))

const timers = new Set<ReturnType<typeof setInterval>>()
const realSetInterval = globalThis.setInterval
globalThis.setInterval = ((handler: () => void, timeout?: number) => {
  const timer = realSetInterval(handler, timeout)
  timers.add(timer)
  return timer
}) as typeof globalThis.setInterval

bootstrapDb()
// vec_thoughts is a vec0 virtual table — v002 skips it on `:memory:` databases.
getDb()
  .prepare(
    'CREATE TABLE IF NOT EXISTS vec_thoughts (id TEXT PRIMARY KEY, embedding BLOB, scope TEXT)'
  )
  .run()

function seedQueued(content: string, hash: string): string {
  const id = seedThought({ content })
  getDb()
    .prepare('UPDATE thoughts SET content = ?, content_hash = ? WHERE id = ?')
    .run(content, hash, id)
  return id
}

function queueRow(
  id: string
): { attempts: number; is_error: number; last_error: string | null } | null {
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
  return new Float32Array(
    stored.embedding.buffer,
    stored.embedding.byteOffset,
    stored.embedding.byteLength / 4
  )[0]
}

interface LogRow {
  level: string
  type: string
  message: string
  metadata: string | null
}

function logRows(): LogRow[] {
  if (!existsSync(logFile)) return []
  const raw = readFileSync(logFile, 'utf8')
  const rows: LogRow[] = []
  for (const line of raw.split('\n')) {
    const trimmed = line.trim()
    if (!trimmed) continue
    try {
      const obj = JSON.parse(trimmed) as {
        level?: string
        type?: string
        msg?: string
        meta?: unknown
      }
      rows.push({
        level: obj.level ?? '',
        type: obj.type ?? '',
        message: obj.msg ?? '',
        metadata: obj.meta === undefined ? null : JSON.stringify(obj.meta)
      })
    } catch {}
  }
  return rows
}

const skipLogs = (): LogRow[] =>
  logRows().filter(r => r.type === 'embedding' && r.message.includes('mid-batch'))
const backoffLogs = (): LogRow[] => logRows().filter(r => r.message.includes('Backing off'))

async function waitFor(what: string, probe: () => boolean, timeoutMs = 10_000): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (probe()) return
    await Bun.sleep(5)
  }
  throw new Error(`timed out after ${timeoutMs}ms waiting for ${what}`)
}

const failedId = seedQueued('failing content', 'hash-fail')

await import('./embedder-process')

afterAll(() => {
  for (const timer of timers) clearInterval(timer)
  realInitFns.closeDb()
  rmSync(scratch, { recursive: true, force: true })
})

test('the shipped process validates the model with the configured dtype', () => {
  expect(ensureModelCalls.length).toBeGreaterThanOrEqual(1)

  const call = ensureModelCalls[0]
  expect(call.dtype).toBe(config.embedder.dtype)
  expect(call.dtype).toBe('fp32')
  expect(call.model).toBe(config.embedder.model)
  expect(call.cacheDir).toBe(config.embedder.cacheDir)
})

test('AC6 (real loop): an all-failed batch drives the backoff, and the store fault reaches handleFailedItem with its message', async () => {
  await waitFor('the all-failed backoff log', () => backoffLogs().length > 0)

  const row = queueRow(failedId)
  expect(row?.last_error).toBe('boom')
  expect(row?.attempts).toBeGreaterThanOrEqual(5)

  const allFailedLog = logRows().find(
    r => r.type === 'embedding' && r.message.startsWith('Batch failed: all')
  )
  expect(allFailedLog).toBeDefined()
}, 20_000)

test('AC2/AC5/AC6/AC8 (real loop): a skipped row never reaches the retire path, is logged, and does not advance the backoff', async () => {
  const backoffBefore = backoffLogs().length

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
  control.drainQueue = true
  await Bun.sleep(20)

  expect(deleteCalls.flat()).toContain(stableId)
  expect(queueRow(stableId)).toBeNull()
  expect(storedMarker(stableId)).toBe(EMBED_MARKER)

  expect(deleteCalls.flat()).not.toContain(skipId)
  expect(skipLogs().length).toBeGreaterThanOrEqual(6)
  const skipped = queueRow(skipId)
  expect(skipped).not.toBeNull()
  expect(skipped?.attempts).toBeGreaterThanOrEqual(1)
  expect(skipped?.is_error).toBe(0)
  expect(skipped?.last_error).toBe(realQueueFns.CONTENT_CHANGED_REASON)

  const skipRow = skipLogs().at(-1)!
  const metadata = JSON.parse(skipRow.metadata ?? '{}') as {
    skippedCount?: number
    reason?: string
    ids?: string[]
  }
  expect(skipRow.level).toBe('warning')
  expect(metadata.reason).toBe(realQueueFns.CONTENT_CHANGED_REASON)
  expect(metadata.skippedCount).toBeGreaterThanOrEqual(1)
  expect(metadata.ids).toContain(skipId)

  expect(backoffLogs().length).toBe(backoffBefore)
}, 20_000)

test('AC1 (real loop): an edit between the store and the retire keeps the row queued, and the next poll re-embeds the update', async () => {
  control.edit = null
  control.drainQueue = false

  const oldHash = 'hash-race-old'
  const newHash = 'hash-race-new'
  const raceId = seedQueued('race content', oldHash)
  const embeddedBefore = embeddedTexts.length

  let raceEdits = 0
  control.retireEdit = ids => {
    if (raceEdits > 0 || !ids.includes(raceId)) return
    raceEdits++
    getDb()
      .prepare('UPDATE thoughts SET content = ?, content_hash = ? WHERE id = ?')
      .run('race content v2', newHash, raceId)
  }

  await waitFor(
    'the raced row to be retired only after its re-embed',
    () => raceEdits === 1 && queueRow(raceId) === null
  )
  control.drainQueue = true
  await Bun.sleep(20)

  expect(raceEdits).toBe(1)

  expect(retireCalls.filter(c => c.id === raceId).map(c => c.contentHash)).toEqual([
    oldHash,
    newHash
  ])

  expect(embeddedTexts.slice(embeddedBefore).filter(t => t.startsWith('race content'))).toEqual([
    'race content',
    'race content v2'
  ])
  expect(queueRow(raceId)).toBeNull()
  expect(storedMarker(raceId)).toBe(EMBED_MARKER)
}, 20_000)
