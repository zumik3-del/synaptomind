import type { Database } from 'bun:sqlite'
import { afterAll, expect, mock, test } from 'bun:test'
import { config } from '../config'
import { getDb } from '../context/container'
import { closeDb } from '../db/init'
import { seedThought } from '../test/helpers'

config.embedder.pollIntervalMs = 600_000
config.embedder.batchSize = 8
config.embedder.precache = true
config.embedder.idleTimeoutMs = 0

const realInitFns = { ...(await import('../db/init')) }
const realQueueFns = { ...(await import('../db/pending-embeddings')) }

const events: string[] = []
const intervals: { handler: () => void; ms: number | undefined }[] = []
const realSetInterval = globalThis.setInterval
globalThis.setInterval = ((handler: () => void, ms?: number) => {
  intervals.push({ handler, ms })
  events.push(`arm:${String(ms)}`)
  return 1 as unknown as ReturnType<typeof setInterval>
}) as typeof globalThis.setInterval

// Fake clock: the poll loop gates each tick on `nextPollAt`, so a manual tick
// must be able to advance past the interval it was armed with.
let clock = Date.UTC(2026, 0, 1)
const realNow = Date.now
Date.now = () => clock

let dbBootstrapped = false
function bootstrapDb(): void {
  if (dbBootstrapped) return
  dbBootstrapped = true
  realInitFns.initDb({ dbPath: ':memory:', runMigrations: true })
}
mock.module('../db/init', () => ({ ...realInitFns, initDb: bootstrapDb }))

const EMBED_MARKER = 44

function markerVector(): Float32Array {
  const v = new Float32Array(config.embedder.dimensions)
  v[0] = EMBED_MARKER
  return v
}

mock.module('./model', () => ({
  generateEmbeddings: async (texts: string[]) => texts.map(() => markerVector()),
  // `handle-request.ts` (the worker's IPC leg) imports the singular form too.
  generateEmbedding: async () => markerVector(),
  resetExtractor: () => {}
}))

mock.module('./model-validator', () => ({ ensureModelFiles: async () => {} }))

// Everything real except the one function whose CALL is the assertion: a tick
// that "performs no sweep query" must leave `sweepOrphanedThoughts` uncalled.
mock.module('../db/pending-embeddings', () => ({
  ...realQueueFns,
  sweepOrphanedThoughts: (db: Database, limit: number) => {
    events.push('sweep-query')
    return realQueueFns.sweepOrphanedThoughts(db, limit)
  }
}))

bootstrapDb()
// vec_thoughts is a vec0 virtual table — v002 skips it on `:memory:` databases.
getDb()
  .prepare(
    'CREATE TABLE IF NOT EXISTS vec_thoughts (id TEXT PRIMARY KEY, embedding BLOB, scope TEXT)'
  )
  .run()

/**
 * Seed an ORPHAN: a thought with neither a vector nor a queue row, i.e. exactly
 * what the sweep's anti-join looks for (the insert trigger created a queue row,
 * so it has to be drained).
 */
function orphan(content: string, status = 'active'): string {
  const id = seedThought({ content, status })
  getDb().prepare('DELETE FROM pending_embeddings WHERE thought_id = ?').run(id)
  return id
}

const queueIds = (): string[] =>
  (
    getDb().prepare('SELECT thought_id FROM pending_embeddings').all() as {
      thought_id: string
    }[]
  ).map(row => row.thought_id)

const vecIds = (): string[] =>
  (getDb().prepare('SELECT id FROM vec_thoughts').all() as { id: string }[]).map(row => row.id)

function clearQueue(): void {
  getDb().prepare('DELETE FROM pending_embeddings').run()
}

const sweepQueries = (): number => events.filter(event => event === 'sweep-query').length

const bootOrphan = orphan('boot orphan')
const archivedOrphan = orphan('archived orphan', 'archived')

await import('./embedder-process')

const sweepTimer = intervals.find(entry => entry.ms !== config.embedder.pollIntervalMs)
const sweepTick = (): void => {
  if (!sweepTimer) throw new Error('no sweep timer was armed')
  sweepTimer.handler()
}
function pollTick(): void {
  const poll = intervals.find(entry => entry.ms === config.embedder.pollIntervalMs)
  if (!poll) throw new Error('no poll timer was armed')
  clock += config.embedder.pollIntervalMs
  poll.handler()
}

async function flush(): Promise<void> {
  for (let i = 0; i < 50; i++) await Promise.resolve()
}

afterAll(() => {
  Date.now = realNow
  globalThis.setInterval = realSetInterval
  closeDb()
})

test('the sweep runs at boot and is re-armed hourly, both read off the timer seam', () => {
  // Cadence: exactly one interval other than the poll loop, and it is an hour —
  // the demotion of #2468 (a 5-minute value here is the regression this pins).
  expect(sweepTimer).toBeDefined()
  expect(sweepTimer?.ms).toBe(60 * 60 * 1000)
  expect(events.filter(event => event === 'arm:3600000').length).toBe(1)

  const bootSweepAt = events.indexOf('sweep-query')
  expect(bootSweepAt).toBeGreaterThanOrEqual(0)
  expect(bootSweepAt).toBeLessThan(events.indexOf('arm:3600000'))
  expect(queueIds()).toContain(bootOrphan)
  expect(queueIds()).not.toContain(archivedOrphan)

  clearQueue()
  const before = sweepQueries()
  sweepTick()
  expect(sweepQueries()).toBe(before + 1)
})

test('a tick with retryable queue work performs no sweep query', () => {
  getDb()
    .prepare('INSERT OR REPLACE INTO pending_embeddings (thought_id, created_at) VALUES (?, ?)')
    .run(bootOrphan, new Date(clock).toISOString())
  expect(realQueueFns.hasPendingEmbeddings(getDb())).toBe(true)

  const before = sweepQueries()
  const requeuesBefore = queueIds().length
  sweepTick()

  expect(sweepQueries()).toBe(before)
  expect(queueIds().length).toBe(requeuesBefore)
})

test('a dead-lettered queue row alone does not suppress the sweep', () => {
  // `hasPendingEmbeddings` counts only retryable rows: a poison row never leaves
  // the dead-letter state without an opt-in reset, so counting it would silently
  // disable the safety net forever.
  getDb()
    .prepare('UPDATE pending_embeddings SET is_error = 1, error = ? WHERE thought_id = ?')
    .run('boom', bootOrphan)
  expect(realQueueFns.hasPendingEmbeddings(getDb())).toBe(false)

  const before = sweepQueries()
  sweepTick()
  expect(sweepQueries()).toBe(before + 1)
})

test('an orphaned live thought is picked up by a tick, and an archived one is never queued', async () => {
  clearQueue()
  getDb().prepare('DELETE FROM vec_thoughts').run()
  const picked = orphan('picked up by the sweep')
  const dropped = orphan('archived, must stay unembedded', 'archived')

  sweepTick()
  expect(queueIds()).toContain(picked)
  expect(queueIds()).not.toContain(dropped)

  pollTick()
  await flush()

  expect(vecIds()).toContain(picked)
  expect(queueIds()).not.toContain(picked)
  expect(vecIds()).not.toContain(dropped)
  expect(queueIds()).not.toContain(dropped)
})

test('the sweep is skipped, not deferred, while work is queued: once drained the next tick sweeps again', () => {
  // Regression guard for a "remember to sweep later" flag: nothing is deferred,
  // the guard is re-evaluated per tick.
  const queued = orphan('queued work during a tick')
  getDb()
    .prepare('INSERT OR REPLACE INTO pending_embeddings (thought_id, created_at) VALUES (?, ?)')
    .run(queued, new Date(clock).toISOString())

  const before = sweepQueries()
  sweepTick()
  expect(sweepQueries()).toBe(before)

  clearQueue()
  sweepTick()
  expect(sweepQueries()).toBe(before + 1)
  expect(queueIds()).toContain(queued)
})
