import { afterAll, expect, mock, test } from 'bun:test'

const MODE = process.env.SYNAPTOMIND_SPAWN_SCOPE_MODE ?? 'delegated'

const openedDbs: string[] = []
const handledMethods: string[] = []
const sent: unknown[] = []
const intervals: number[] = []
let initDbCalls = 0
let pollHandler: (() => void) | undefined

const originalSetInterval = globalThis.setInterval
const originalSend = process.send

globalThis.setInterval = ((fn: () => void, ms?: number) => {
  intervals.push(ms ?? 0)
  if (ms === 10) pollHandler = fn
  return 1 as unknown as ReturnType<typeof setInterval>
}) as typeof setInterval

process.send = ((message: unknown) => {
  sent.push(message)
  return true
}) as typeof process.send

mock.module('../config', () => ({
  config: {
    users: [
      { id: 'alpha', dbPath: 'alpha.db', tokenSha256: '0'.repeat(64) },
      { id: 'beta', dbPath: 'beta.db', tokenSha256: '1'.repeat(64) }
    ],
    embedder: {
      batchSize: 8,
      pollIntervalMs: 10,
      precache: true,
      idleTimeoutMs: 60_000,
      cacheDir: '',
      model: '',
      dtype: 'q8'
    }
  }
}))
mock.module('../db/init', () => ({
  initDb: () => {
    initDbCalls++
  },
  closeDb: () => {},
  openDatabase: ({ dbPath }: { dbPath?: string } = {}) => {
    openedDbs.push(dbPath ?? 'legacy')
    return { close: () => {} }
  }
}))
mock.module('../context/container', () => ({
  getDb: () => {
    throw new Error('unexpected legacy mode')
  }
}))
mock.module('../logging', () => ({ insertLog: () => {} }))
mock.module('./model-validator', () => ({ ensureModelFiles: async () => {} }))
mock.module('./handle-request', () => ({
  handleEmbedderRequest: async (message: { method?: string }) => {
    handledMethods.push(message.method ?? '')
  }
}))
mock.module('./model', () => ({
  generateEmbeddings: async () => [],
  resetExtractor: () => {}
}))
mock.module('../db/pending-embeddings', () => ({
  CONTENT_CHANGED_REASON: 'changed',
  findPendingEmbeddings: () => [],
  insertEmbedding: () => true,
  deleteEmbeddedFromQueue: () => {},
  handleFailedItem: () => {},
  hasPendingEmbeddings: () => true,
  requeueEmbeddings: () => {},
  sweepOrphanedThoughts: () => []
}))

if (MODE === 'delegated') {
  process.env.SYNAPTOMIND_EMBEDDER_BATCH_WORKER = 'false'
} else {
  process.env.SYNAPTOMIND_EMBEDDER_USERS = JSON.stringify([{ id: 'beta', dbPath: 'beta.db' }])
}

await import('./embedder-process')

async function flush(): Promise<void> {
  for (let i = 0; i < 100; i++) await Promise.resolve()
}

function emitMessage(payload: unknown): void {
  ;(process.emit as (event: string, value: unknown) => boolean)('message', payload)
}

afterAll(() => {
  globalThis.setInterval = originalSetInterval
  process.send = originalSend
  delete process.env.SYNAPTOMIND_EMBEDDER_BATCH_WORKER
  delete process.env.SYNAPTOMIND_EMBEDDER_USERS
})

if (MODE === 'delegated') {
  test('a delegated child opens no database, starts no poll/sweep worker, and still reports ready', async () => {
    await flush()

    expect(initDbCalls).toBe(0)
    expect(openedDbs).toEqual([])
    expect(pollHandler).toBeUndefined()
    expect(intervals).toEqual([])
    expect(sent).toEqual([{ type: 'ready', protocol: 1 }])
  })

  test('a delegated child still serves on-demand requests', async () => {
    emitMessage({ type: 'request', id: 'r1', method: 'embed', params: { text: 'x' } })
    await flush()

    expect(handledMethods).toEqual(['embed'])
    expect(openedDbs).toEqual([])
  })
} else {
  test('the child fans out over exactly the assigned user list', async () => {
    await flush()

    expect(openedDbs).toEqual(['beta.db'])
    expect(pollHandler).toBeDefined()
    expect(intervals).toEqual([10, 3_600_000])
    expect(sent).toEqual([{ type: 'ready', protocol: 1 }])

    for (let i = 0; i < 5; i++) {
      pollHandler?.()
      await flush()
    }

    expect(openedDbs).toEqual(['beta.db'])
    expect(openedDbs).not.toContain('alpha.db')
  })
}
