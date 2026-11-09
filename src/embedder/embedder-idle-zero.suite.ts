import { afterAll, expect, mock, test } from 'bun:test'

let poll: (() => void) | undefined
let timeouts = 0
let exits = 0
let queued = true
const originalTimeout = globalThis.setTimeout
const originalClearTimeout = globalThis.clearTimeout
const originalInterval = globalThis.setInterval
const originalClearInterval = globalThis.clearInterval
const originalExit = process.exit
globalThis.setTimeout = (() => {
  timeouts++
  return 1
}) as unknown as typeof setTimeout
globalThis.clearTimeout = (() => {}) as typeof clearTimeout
globalThis.setInterval = ((fn: () => void, ms: number) => {
  if (ms === 10) poll = fn
  return 1
}) as unknown as typeof setInterval
globalThis.clearInterval = (() => {}) as typeof clearInterval
process.exit = ((code: number) => {
  exits = code === 0 ? exits + 1 : -1
}) as typeof process.exit

mock.module('../config', () => ({
  config: {
    users: [{ id: 'user', dbPath: 'user' }],
    embedder: {
      batchSize: 1,
      pollIntervalMs: 10,
      precache: false,
      idleTimeoutMs: 0,
      cacheDir: '',
      model: '',
      dtype: 'q8'
    }
  }
}))
mock.module('../db/init', () => ({
  initDb: () => {},
  closeDb: () => {},
  openDatabase: () => ({
    close: () => {}
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
  resetExtractor: () => {}
}))
mock.module('../db/pending-embeddings', () => ({
  CONTENT_CHANGED_REASON: 'changed',
  findPendingEmbeddings: () => (queued ? [{ id: 'row', content: 'row', contentHash: 'hash' }] : []),
  insertEmbedding: () => true,
  deleteFromQueue: () => {
    queued = false
  },
  handleFailedItem: () => {},
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

test('idleTimeoutMs 0 with precache off never schedules an idle timer nor exits', async () => {
  await flush()
  expect(queued).toBe(false)
  expect(poll).toBeDefined()
  expect(timeouts).toBe(0)
  expect(exits).toBe(0)

  poll?.()
  await flush()
  expect(timeouts).toBe(0)
  expect(exits).toBe(0)
})
