import { afterAll, expect, mock, test } from 'bun:test'

type Mode = 'all-failed' | 'catch' | 'ok'
const MODE = (process.env.SYNAPTOMIND_BACKOFF_MODE ?? 'all-failed') as Mode

interface LogEntry {
  level: string
  message: string
  meta?: Record<string, unknown>
}

const logs: LogEntry[] = []
const consoleErrors: string[] = []
const row = { id: 'row', content: 'row', contentHash: 'hash' }

let now = 1_000_000
let rounds = 0
let pollHandler: (() => void) | undefined

const originalNow = Date.now
const originalSetInterval = globalThis.setInterval
const originalConsoleError = console.error

Date.now = () => now
globalThis.setInterval = ((fn: () => void, ms?: number) => {
  if (ms === 10) pollHandler = fn
  return 1 as unknown as ReturnType<typeof setInterval>
}) as typeof setInterval
console.error = ((...args: unknown[]) => {
  consoleErrors.push(args.map(arg => String(arg)).join(' '))
}) as typeof console.error

mock.module('../config', () => ({
  config: {
    users: [],
    embedder: {
      enabled: true,
      batchSize: 8,
      pollIntervalMs: 10,
      precache: true,
      idleTimeoutMs: 60_000,
      cacheDir: '',
      model: '',
      dtype: 'q8',
      dimensions: 3
    }
  }
}))
mock.module('../db/init', () => ({
  initDb: () => {},
  closeDb: () => {},
  openDatabase: () => ({ close: () => {} })
}))
mock.module('../context/container', () => ({ getDb: () => ({ close: () => {} }) }))
mock.module('../logging', () => ({
  insertLog: (level: string, _type: string, message: string, meta?: Record<string, unknown>) => {
    logs.push({ level, message, meta })
  }
}))
mock.module('./model-validator', () => ({ ensureModelFiles: async () => {} }))
mock.module('./handle-request', () => ({ handleEmbedderRequest: async () => {} }))
mock.module('./model', () => ({
  generateEmbeddings: async (texts: string[]) => {
    if (MODE === 'catch') throw new Error('model exploded')
    now += 7
    return texts.map(() => new Float32Array([1]))
  },
  resetExtractor: () => {}
}))
mock.module('../db/pending-embeddings', () => ({
  CONTENT_CHANGED_REASON: 'changed',
  findPendingEmbeddings: () => {
    rounds++
    return [row]
  },
  insertEmbedding: () => {
    if (MODE === 'all-failed') throw new Error('boom')
    return true
  },
  deleteEmbeddedFromQueue: () => {},
  handleFailedItem: () => {},
  hasPendingEmbeddings: () => true,
  requeueEmbeddings: () => {},
  sweepOrphanedThoughts: () => []
}))

await import('./embedder-process')

async function flush(): Promise<void> {
  for (let i = 0; i < 100; i++) await Promise.resolve()
}

async function tick(): Promise<void> {
  now += 10
  pollHandler?.()
  await flush()
}

const backoffLogs = (): LogEntry[] => logs.filter(l => l.message.startsWith('Backing off to '))

afterAll(() => {
  Date.now = originalNow
  globalThis.setInterval = originalSetInterval
  console.error = originalConsoleError
})

test(`${MODE}: the batch loop starts its poller`, async () => {
  await flush()
  expect(pollHandler).toBeDefined()
})

if (MODE === 'ok') {
  test('a successful round logs a measured durationMs', async () => {
    for (let i = 0; i < 10 && !logs.some(l => l.message.startsWith('Embedded ')); i++) {
      await tick()
    }

    const embedded = logs.find(l => l.message.startsWith('Embedded '))
    expect(embedded?.level).toBe('info')
    expect(embedded?.message).toBe('Embedded 1 thought(s)')
    expect(embedded?.meta?.durationMs).toBe(7)
    expect(backoffLogs()).toHaveLength(0)
  })
} else {
  test('the backoff advances once per five rounds, logs the pre-reset count, and starts the next run from one', async () => {
    for (let i = 0; i < 400 && backoffLogs().length < 2; i++) {
      await tick()
    }

    const backoff = backoffLogs()
    expect(backoff).toHaveLength(2)
    expect(backoff.map(l => l.meta?.consecutiveFailures)).toEqual([5, 5])
    expect(backoff.map(l => l.meta?.backoff)).toEqual(MODE === 'all-failed' ? [2, 2] : [2, 4])
    // The second threshold lands on round ten; without the reset it would land on round six.
    expect(rounds).toBe(10)

    const preResetLines = consoleErrors.filter(line => line.includes('(5/5)'))
    expect(preResetLines).toHaveLength(2)
    expect(consoleErrors.some(line => line.includes('(6/5)'))).toBe(false)
  })
}
