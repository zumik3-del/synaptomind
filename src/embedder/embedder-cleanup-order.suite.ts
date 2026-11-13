import { Database } from 'bun:sqlite'
import { afterAll, expect, mock, test } from 'bun:test'
import { existsSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { getDb } from '../context/container'

const MODE = process.env.SYNAPTOMIND_CLEANUP_MODE ?? 'legacy-idle'
const MULTI = MODE.startsWith('multi-')
const SCRATCH = mkdtempSync(join(tmpdir(), `synaptomind-cleanup-${MODE}-`))
const DB_PATHS = MULTI
  ? [join(SCRATCH, 'one.db'), join(SCRATCH, 'two.db')]
  : [join(SCRATCH, 'legacy.db')]
const POLL_INTERVAL_MS = 10

let idle: (() => void) | undefined
let exits = 0
const originalTimeout = globalThis.setTimeout
const originalClearTimeout = globalThis.clearTimeout
const originalInterval = globalThis.setInterval
const originalClearInterval = globalThis.clearInterval
const originalExit = process.exit

globalThis.setTimeout = ((fn: () => void) => {
  idle = fn
  return 1
}) as unknown as typeof setTimeout
globalThis.clearTimeout = (() => {}) as typeof clearTimeout
globalThis.setInterval = ((_fn: () => void) => 1) as unknown as typeof setInterval
globalThis.clearInterval = (() => {}) as typeof clearInterval
process.exit = ((code?: number) => {
  exits = code === 0 ? exits + 1 : -1
}) as typeof process.exit

mock.module('../config', () => ({
  config: {
    users: MULTI ? DB_PATHS.map((dbPath, i) => ({ id: `user-${i}`, dbPath })) : [],
    db: { path: DB_PATHS[0], busyTimeout: 5000 },
    embedder: {
      enabled: true,
      model: '',
      dtype: 'q8',
      dimensions: 4,
      pollIntervalMs: POLL_INTERVAL_MS,
      cacheDir: '',
      batchSize: 10,
      precache: false,
      idleTimeoutMs: 60_000
    }
  }
}))
mock.module('../logging', () => ({ insertLog: () => {} }))
mock.module('./model-validator', () => ({ ensureModelFiles: async () => {} }))
mock.module('./handle-request', () => ({ handleEmbedderRequest: async () => {} }))
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

await import('./embedder-process')

async function flush(): Promise<void> {
  for (let i = 0; i < 100; i++) await Promise.resolve()
}

function probe(db: Database): string[] {
  const events: string[] = []
  const realRun = db.run.bind(db)
  db.run = ((sql: string, ...args: unknown[]) => {
    events.push(`run:${sql}`)
    return realRun(sql, ...(args as never[]))
  }) as unknown as typeof db.run
  const realClose = db.close.bind(db)
  db.close = ((throwOnError?: boolean) => {
    events.push('close')
    return realClose(throwOnError)
  }) as typeof db.close
  return events
}

afterAll(() => {
  globalThis.setTimeout = originalTimeout
  globalThis.clearTimeout = originalClearTimeout
  globalThis.setInterval = originalInterval
  globalThis.clearInterval = originalClearInterval
  process.exit = originalExit
  rmSync(SCRATCH, { recursive: true, force: true })
})

test(`${MODE}: closeDb runs on an open handle and every DB ends closed`, async () => {
  const errors: string[] = []
  const originalError = console.error
  console.error = ((...args: unknown[]) => {
    errors.push(args.map(arg => String(arg)).join(' '))
  }) as typeof console.error

  try {
    await flush()
    const events = MULTI ? [] : probe(getDb())

    for (const path of DB_PATHS) expect(existsSync(`${path}-wal`)).toBe(true)

    if (MODE.endsWith('idle')) {
      expect(idle).toBeDefined()
      idle?.()
    } else {
      ;(process.emit as (event: string, payload: unknown) => boolean)('message', {
        type: 'shutdown'
      })
    }

    expect(exits).toBe(1)
    expect(errors.filter(line => line.includes('wal_checkpoint(TRUNCATE) failed'))).toEqual([])
    expect(errors.filter(line => line.includes('[db] close failed'))).toEqual([])

    for (const path of DB_PATHS) {
      expect(existsSync(`${path}-wal`)).toBe(false)
      expect(existsSync(`${path}-shm`)).toBe(false)
      const reopened = new Database(path, { readonly: true })
      try {
        expect(reopened.query('SELECT count(*) AS n FROM _meta').get()).toBeDefined()
      } finally {
        reopened.close()
      }
    }

    if (MULTI) {
      expect(() => getDb()).toThrow()
    } else {
      const checkpoint = events.findIndex(event => event.startsWith('run:PRAGMA wal_checkpoint'))
      const firstClose = events.indexOf('close')
      expect(checkpoint).toBeGreaterThanOrEqual(0)
      expect(firstClose).toBeGreaterThan(checkpoint)
      expect(events.filter(event => event === 'close').length).toBeGreaterThanOrEqual(2)
      expect(() => getDb()).toThrow()
    }
  } finally {
    console.error = originalError
  }
})
