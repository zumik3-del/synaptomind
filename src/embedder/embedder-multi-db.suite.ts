import { Database } from 'bun:sqlite'
import { afterAll, expect, mock, test } from 'bun:test'
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { config } from '../config'
import { openDatabase } from '../db/init'
import { vec0Path } from '../runtime-mode'

// Task #2299: the mocked scheduler suite (#2298) proves the backoff ARITHMETIC
// with a fake DB layer; what it cannot prove is that a real SQLite queue on one
// user's database keeps draining while another user's database cannot even be
// opened. This suite keeps the real `openDatabase`, real `pending_embeddings`
// and real `vec_thoughts` (file-backed, so vec0 loads), and mocks only the
// model/IPC/logging edges — i.e. the parts that would download a model or talk
// to a parent process.
//
// The poll interval is driven by a captured timer, so ticks are deterministic
// and the suite leaves no live interval behind.

const root = mkdtempSync(join(tmpdir(), 'synaptomind-multi-db-'))
const healthyPath = join(root, 'healthy.db')
const brokenPath = join(root, 'broken.db')

const DIMENSIONS = config.embedder.dimensions

function seedUserDb(path: string, contents: string[]): void {
  const db = openDatabase({ dbPath: path, runMigrations: true })
  const now = new Date().toISOString()
  db.run('INSERT OR IGNORE INTO projects (id, name, created_at) VALUES (?, ?, ?)', ['default', 'Default', now])
  for (const content of contents) {
    db.run(
      'INSERT INTO thoughts (id, content, status, project_id, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)',
      [Bun.randomUUIDv7(), content, 'active', 'default', now, now],
    )
  }
  db.close(true)
}

// A directory where a database file is expected: every open throws, which is
// the real "this user's DB is unavailable" condition, not a mocked rejection.
mkdirSync(brokenPath)
seedUserDb(healthyPath, ['healthy-private-marker-1', 'healthy-private-marker-2'])

config.users = [
  { id: 'broken', dbPath: brokenPath, tokenSha256: '0'.repeat(64) },
  { id: 'healthy', dbPath: healthyPath, tokenSha256: '1'.repeat(64) },
]
config.embedder.pollIntervalMs = 10
config.embedder.batchSize = 10
config.embedder.precache = true
config.embedder.idleTimeoutMs = 60_000

let poll: (() => void) | undefined
let now = 0
const originalNow = Date.now
const originalInterval = globalThis.setInterval
Date.now = () => now
globalThis.setInterval = ((fn: () => void, ms?: number) => {
  if (ms === config.embedder.pollIntervalMs) poll = fn
  return 1 as unknown as ReturnType<typeof setInterval>
}) as typeof setInterval

mock.module('../logging', () => ({ insertLog: () => {} }))
mock.module('./model-validator', () => ({ ensureModelFiles: async () => {} }))
mock.module('./handle-request', () => ({ handleEmbedderRequest: async () => {} }))
mock.module('./model', () => ({
  generateEmbeddings: async (texts: string[]) =>
    texts.map(() => {
      const v = new Float32Array(DIMENSIONS)
      v[0] = 0.5
      return v
    }),
  resetExtractor: () => {},
}))

await import('./embedder-process')

async function flush(): Promise<void> {
  for (let i = 0; i < 50; i++) await Promise.resolve()
}

async function tick(times: number): Promise<void> {
  for (let i = 0; i < times; i++) {
    now += config.embedder.pollIntervalMs
    poll?.()
    await flush()
  }
}

interface Counts {
  pending: number
  vectors: number
  contents: string[]
}

/** Read a user's real queue/vector state through a vec0-capable connection. */
function counts(path: string): Counts {
  const db = new Database(path, { readonly: true })
  try {
    db.loadExtension(vec0Path())
    const pending = db.query('SELECT count(*) AS n FROM pending_embeddings').get() as { n: number }
    const vectors = db.query('SELECT count(*) AS n FROM vec_thoughts').get() as { n: number }
    const contents = (db.query('SELECT content FROM thoughts ORDER BY content').all() as Array<{ content: string }>)
      .map(r => r.content)
    return { pending: pending.n, vectors: vectors.n, contents }
  } finally {
    db.close()
  }
}

afterAll(() => {
  Date.now = originalNow
  globalThis.setInterval = originalInterval
  rmSync(root, { recursive: true, force: true })
})

test('a healthy user queue drains while another user DB cannot open, and resumes after recovery', async () => {
  await flush()
  expect(poll).toBeDefined()

  await tick(5)

  // The healthy user's real rows went through the real queue and the real
  // vec0 table, while the broken user kept failing to open.
  const healthyDuring = counts(healthyPath)
  expect(healthyDuring.pending).toBe(0)
  expect(healthyDuring.vectors).toBe(2)
  expect(healthyDuring.contents).toEqual(['healthy-private-marker-1', 'healthy-private-marker-2'])

  // Recovery: the path becomes a real, migrated database with one queued row.
  rmSync(brokenPath, { recursive: true, force: true })
  seedUserDb(brokenPath, ['recovered-private-marker'])
  await tick(20)

  const brokenAfter = counts(brokenPath)
  expect(brokenAfter.pending).toBe(0)
  expect(brokenAfter.vectors).toBe(1)
  expect(brokenAfter.contents).toEqual(['recovered-private-marker'])

  // Isolation held in both directions and the outage cost the healthy user
  // nothing: no cross-write, no dead letter.
  const healthyAfter = counts(healthyPath)
  expect(healthyAfter.pending).toBe(0)
  expect(healthyAfter.vectors).toBe(2)
  expect(healthyAfter.contents).not.toContain('recovered-private-marker')
  expect(brokenAfter.contents).not.toContain('healthy-private-marker-1')
})
