import { afterAll, expect, mock, test } from 'bun:test'

type Mode = 'all-failed' | 'catch' | 'ok' | 'recover'
const MODE = (process.env.SYNAPTOMIND_BACKOFF_MODE ?? 'all-failed') as Mode

const MAX_CONSECUTIVE_FAILURES = 5
const MAX_BACKOFF = 64
const FAIL_ROUNDS_BEFORE_SUCCESS = 6
const SUCCESS_ROUND = FAIL_ROUNDS_BEFORE_SUCCESS + 1

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
let storeAttempts = 0
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
    storeAttempts++
    if (MODE === 'all-failed') throw new Error('boom')
    if (MODE === 'recover' && storeAttempts !== SUCCESS_ROUND) throw new Error('boom')
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
const backoffValues = (): unknown[] => backoffLogs().map(l => l.meta?.backoff)
const failureCounts = (): unknown[] => backoffLogs().map(l => l.meta?.consecutiveFailures)

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
}

if (MODE === 'catch') {
  test('the catch branch doubles its backoff every five failed rounds', async () => {
    for (let i = 0; i < 400 && backoffLogs().length < 2; i++) {
      await tick()
    }

    expect(failureCounts()).toEqual([5, 5])
    expect(backoffValues()).toEqual([2, 4])
    // The second threshold lands on round ten; without the reset it would land on round six.
    expect(rounds).toBe(10)

    expect(consoleErrors.filter(line => line.includes('(5/5)'))).toHaveLength(2)
    expect(consoleErrors.some(line => line.includes('(6/5)'))).toBe(false)
  })
}

if (MODE === 'all-failed') {
  test('a permanently failing store path ramps every five rounds up to the cap', async () => {
    for (let i = 0; i < 4000 && backoffLogs().length < 6; i++) {
      await tick()
    }

    expect(backoffValues()).toEqual([2, 4, 8, 16, 32, 64])
    expect(failureCounts()).toEqual([5, 5, 5, 5, 5, 5])
    // Six doublings at five rounds each: the cap is reached on round thirty, not after two.
    expect(rounds).toBe(30)
  })

  test('the cap is stable: no further doubling, no extra log, and the poll gate holds at 64x', async () => {
    const cappedRounds = rounds
    const cappedLogs = backoffLogs().length

    for (let i = 0; i < 400; i++) {
      await tick()
    }

    // Four seconds of simulated time fits ~6 rounds behind the 64x gate; a snap back to 1x would fit
    // hundreds, so the count is what proves the multiplier survived the cap.
    const advanced = rounds - cappedRounds
    expect(advanced).toBeGreaterThanOrEqual(5)
    expect(advanced).toBeLessThanOrEqual(8)
    // Those rounds crossed a further threshold, which must not log again or restart the ramp.
    expect(backoffLogs()).toHaveLength(cappedLogs)
    expect(backoffValues()).toEqual([2, 4, 8, 16, 32, 64])
    expect(
      consoleErrors.filter(line => line.includes(`backing off to ${MAX_BACKOFF}x`))
    ).toHaveLength(1)
  })
}

if (MODE === 'recover') {
  test('a single success resets the ramp to 1x', async () => {
    for (let i = 0; i < 400 && backoffLogs().length < 2; i++) {
      await tick()
    }

    // Six failed rounds, one success, five failed rounds again: the second threshold starts a fresh
    // ramp from 1x, so it doubles to 2x. A ramp that ignored the success would reach 4x here.
    expect(failureCounts()).toEqual([MAX_CONSECUTIVE_FAILURES, MAX_CONSECUTIVE_FAILURES])
    expect(backoffValues()).toEqual([2, 2])
    expect(rounds).toBe(12)
    expect(logs.filter(l => l.message.startsWith('Embedded '))).toHaveLength(1)
  })
}
