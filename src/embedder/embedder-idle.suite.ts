import { afterAll, expect, mock, test } from 'bun:test'

let idle: (() => void) | undefined
let poll: (() => void) | undefined
let clears = 0
let resets = 0
let closes = 0
let exits = 0
let timeouts = 0
let queued = true
const originalTimeout = globalThis.setTimeout
const originalClearTimeout = globalThis.clearTimeout
const originalInterval = globalThis.setInterval
const originalClearInterval = globalThis.clearInterval
const originalExit = process.exit
globalThis.setTimeout = ((fn: () => void) => {
  timeouts++
  idle = fn
  return 1
}) as unknown as typeof setTimeout
globalThis.clearTimeout = (() => {
  clears++
}) as typeof clearTimeout
globalThis.setInterval = ((fn: () => void, ms: number) => {
  if (ms === 10) poll = fn
  return 1
}) as unknown as typeof setInterval
globalThis.clearInterval = (() => {}) as typeof clearInterval
process.exit = ((code: number) => {
  exits = code === 0 ? exits + 1 : -1
}) as typeof process.exit

const mockedConfig = {
  users: [{ id: 'user', dbPath: 'user' }],
  embedder: {
    batchSize: 1,
    pollIntervalMs: 10,
    precache: false,
    idleTimeoutMs: 1000,
    cacheDir: '',
    model: '',
    dtype: 'q8'
  }
}

mock.module('../config', () => ({ config: mockedConfig }))
mock.module('../db/init', () => ({
  initDb: () => {},
  closeDb: () => {},
  openDatabase: () => ({
    close: () => {
      closes++
    }
  })
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
  generateEmbeddings: async () => [new Float32Array([1])],
  resetExtractor: () => {
    resets++
  }
}))
mock.module('../db/pending-embeddings', () => ({
  CONTENT_CHANGED_REASON: 'changed',
  findPendingEmbeddings: () => (queued ? [{ id: 'row', content: 'row', contentHash: 'hash' }] : []),
  insertEmbedding: () => true,
  deleteEmbeddedFromQueue: () => {
    queued = false
  },
  handleFailedItem: () => {},
  hasPendingEmbeddings: () => true,
  requeueEmbeddings: () => {},
  sweepOrphanedThoughts: () => []
}))

await import('./embedder-process')
async function flush() {
  for (let i = 0; i < 20; i++) await Promise.resolve()
}
afterAll(() => {
  globalThis.setTimeout = originalTimeout
  globalThis.clearTimeout = originalClearTimeout
  globalThis.setInterval = originalInterval
  globalThis.clearInterval = originalClearInterval
  process.exit = originalExit
})

test('work resets idle deadline; empty polls do not prevent unload', async () => {
  await flush()
  expect(queued).toBe(false)
  expect(clears).toBeGreaterThan(0)
  expect(poll).toBeDefined()
  const clearsAfterWork = clears
  poll?.()
  await flush()
  expect(clears).toBe(clearsAfterWork)
  expect(idle).toBeDefined()
  idle?.()
  expect(resets).toBe(1)
  expect(closes).toBe(1)
  expect(exits).toBe(1)
})

test('idleTimeoutMs 0 with precache off never schedules an idle timer nor exits', async () => {
  mockedConfig.embedder.idleTimeoutMs = 1000
  queued = true
  await Bun.sleep(20)
  poll?.()
  await flush()
  expect(queued).toBe(false)

  const clearsBefore = clears
  const timeoutsBefore = timeouts
  const exitsBefore = exits

  mockedConfig.embedder.idleTimeoutMs = 0
  queued = true
  await Bun.sleep(20)
  poll?.()
  await flush()

  expect(queued).toBe(false)
  expect(clears).toBeGreaterThan(clearsBefore)
  expect(timeouts).toBe(timeoutsBefore)
  expect(exits).toBe(exitsBefore)
})
