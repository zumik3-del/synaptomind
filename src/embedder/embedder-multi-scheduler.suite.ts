import type { Database } from 'bun:sqlite'
import { afterAll, expect, mock, test } from 'bun:test'

// Drive the actual side-effect worker in an isolated module registry with a
// deterministic clock. Database identities remain distinct at every queue call.
const dbs = Object.fromEntries(
  ['bad', 'healthy', 'opening'].map(id => [id, { id } as unknown as Database])
)
const idOf = (db: Database) => (db as unknown as { id: string }).id
const polls: { id: string; at: number }[] = []
const writes: { db: string; row: string }[] = []
let now = 0
let badFails = true
let openFails = true
let poll: (() => void) | undefined
const originalNow = Date.now
const originalInterval = globalThis.setInterval
Date.now = () => now
globalThis.setInterval = ((fn: () => void, ms?: number) => {
  if (ms === 10) {
    // Focused repro of the old shared-backoff defect: suppress every other
    // entire poll after the fifth failure, instead of delaying just one DB.
    poll =
      process.env.TEST_SHARED_BACKOFF_REPRO === '1'
        ? () => {
            if (now < 50 || now % 20 === 0) fn()
          }
        : fn
  }
  return 1 as unknown as ReturnType<typeof setInterval>
}) as typeof setInterval

mock.module('../config', () => ({
  config: {
    users: ['bad', 'healthy', 'opening'].map(id => ({ id, dbPath: id })),
    embedder: {
      batchSize: 1,
      pollIntervalMs: 10,
      precache: true,
      idleTimeoutMs: 1000,
      cacheDir: '',
      model: '',
      dtype: 'q8'
    }
  }
}))
mock.module('../db/init', () => ({
  initDb: () => {},
  closeDb: () => {},
  openDatabase: ({ dbPath }: { dbPath: string }) => {
    if (dbPath === 'opening' && openFails) throw new Error('open failure')
    return dbs[dbPath]
  }
}))
mock.module('../db/container', () => ({
  getDb: () => {
    throw new Error('unexpected legacy mode')
  }
}))
mock.module('../logging', () => ({ insertLog: () => {} }))
mock.module('./model-validator', () => ({ ensureModelFiles: async () => {} }))
mock.module('./handle-request', () => ({ handleEmbedderRequest: async () => {} }))
mock.module('./model', () => ({
  generateEmbeddings: async (texts: string[]) => {
    if (texts[0] === 'bad' && badFails) throw new Error('model failure')
    return texts.map(() => new Float32Array([1]))
  },
  resetExtractor: () => {}
}))
mock.module('../db/pending-embeddings', () => ({
  CONTENT_CHANGED_REASON: 'changed',
  findPendingEmbeddings: (db: Database) => {
    const id = idOf(db)
    polls.push({ id, at: now })
    return [{ id, content: id, contentHash: id }]
  },
  insertEmbedding: (db: Database, row: string) => {
    writes.push({ db: idOf(db), row })
    return true
  },
  deleteEmbeddedFromQueue: () => {},
  handleFailedItem: () => {},
  hasPendingEmbeddings: () => true,
  requeueEmbeddings: () => {},
  sweepOrphanedThoughts: () => []
}))

await import('./embedder-process')
async function flush() {
  for (let i = 0; i < 20; i++) await Promise.resolve()
}
async function tick() {
  now += 10
  poll?.()
  await flush()
}
afterAll(() => {
  Date.now = originalNow
  globalThis.setInterval = originalInterval
})

test('failed opens and processing back off independently while healthy work continues, then recover', async () => {
  await flush()
  expect(poll).toBeDefined()
  for (let i = 0; i < 15; i++) await tick()
  const healthyBefore = polls.filter(p => p.id === 'healthy').length
  const badBefore = polls.filter(p => p.id === 'bad').length
  expect(healthyBefore).toBe(16)
  expect(badBefore).toBeLessThan(healthyBefore)
  expect(writes.filter(w => w.db === 'healthy').length).toBe(healthyBefore)
  expect(writes.every(w => w.db === w.row)).toBe(true)
  expect(writes.some(w => w.db === 'opening')).toBe(false)

  badFails = false
  openFails = false
  for (let i = 0; i < 20; i++) await tick()
  expect(writes.some(w => w.db === 'bad')).toBe(true)
  expect(writes.some(w => w.db === 'opening')).toBe(true)
  expect(writes.every(w => w.db === w.row)).toBe(true)
  const recent = polls.filter(p => p.at >= now - 40 && p.id === 'bad')
  expect(recent.length).toBe(5)
})

test('successive eligible rounds rotate the first database', () => {
  const rounds = new Map<number, string[]>()
  for (const p of polls) rounds.set(p.at, [...(rounds.get(p.at) ?? []), p.id])
  const fullRounds = [...rounds.values()].filter(ids => ids.length === 3)
  expect(fullRounds.length).toBeGreaterThanOrEqual(3)
  expect(new Set(fullRounds.map(ids => ids[0])).size).toBe(3)
})
