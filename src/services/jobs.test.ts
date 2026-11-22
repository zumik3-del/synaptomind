import type { Database } from 'bun:sqlite'
import { afterEach, describe, expect, test } from 'bun:test'
import { clearRegistry, getDb, register } from '../db'
import { closeDb } from '../db/init'
import { createTestDb, seedThought } from '../test/helpers'
import { runDecayJob, startDecayJob, stopDecayJob } from './decay.service'
import { createIntervalJob } from './jobs.service'

const started: Array<{ stop: () => void }> = []

function track<T extends { start: () => void; stop: () => void }>(job: T): T {
  started.push(job)
  return job
}

afterEach(() => {
  for (const job of started) job.stop()
  started.length = 0
})

describe('createIntervalJob', () => {
  test('a second start does not leak the first timer', () => {
    let ticks = 0
    const job = track(
      createIntervalJob({ name: 'double-start', intervalMs: 5 }, () => {
        ticks++
      })
    )

    job.start()
    const firstTimer = ticks
    job.start()
    expect(ticks).toBe(firstTimer)
  })

  test('start is idempotent: stop() still clears the only live timer', async () => {
    let ticks = 0
    const job = createIntervalJob({ name: 'stop-clears', intervalMs: 5 }, () => {
      ticks++
    })

    job.start()
    job.start()
    await Bun.sleep(40)
    const afterStart = ticks
    expect(afterStart).toBeGreaterThan(0)

    job.stop()
    await Bun.sleep(40)
    expect(ticks).toBe(afterStart)
  })

  test('a refused guard leaves the job startable later', () => {
    let ticks = 0
    let allowed = false
    const job = track(
      createIntervalJob({ name: 'guard', intervalMs: 5, guard: () => allowed }, () => {
        ticks++
      })
    )

    job.start()
    expect(ticks).toBe(0)
    allowed = true
    job.start()
    // The uniform immediate first run fires once as soon as the guard admits it.
    expect(ticks).toBe(1)
  })

  test('an async job rejection is routed to onError, not an unhandled rejection', async () => {
    const errors: string[] = []
    const job = track(
      createIntervalJob(
        { name: 'async-error', intervalMs: 5, onError: err => errors.push(String(err)) },
        () => Promise.reject(new Error('async boom'))
      )
    )

    job.start()
    await Bun.sleep(30)
    expect(errors.length).toBeGreaterThan(0)
    expect(errors[0]).toContain('async boom')
  })

  test('a synchronous throw is routed to onError and the job keeps ticking', async () => {
    const errors: string[] = []
    const job = track(
      createIntervalJob(
        { name: 'sync-error', intervalMs: 5, onError: err => errors.push(String(err)) },
        () => {
          throw new Error('sync boom')
        }
      )
    )

    job.start()
    await Bun.sleep(30)
    expect(errors.length).toBeGreaterThan(1)
  })
})

function seedStale(): () => number {
  const db = getDb()
  const id = seedThought({ status: 'active', is_protected: 0 })
  const twoDaysAgo = new Date(Date.now() - 2 * 86400000).toISOString()
  db.prepare(
    'UPDATE thought_importance SET importance = 0.8, last_decay = ? WHERE thought_id = ?'
  ).run(twoDaysAgo, id)
  return () =>
    (
      db.prepare('SELECT importance FROM thought_importance WHERE thought_id = ?').get(id) as {
        importance: number
      }
    ).importance
}

describe('the shipped decay job', () => {
  test('startDecayJob decays before its day-long interval is armed', async () => {
    createTestDb()
    const importance = seedStale()

    startDecayJob()
    try {
      expect(importance()).toBeLessThan(0.8)
    } finally {
      await stopDecayJob()
      closeDb()
    }
  })

  test('a failing user database is named and does not stop the later users', () => {
    createTestDb()
    const importance = seedStale()
    const good = getDb()
    const bad = {
      prepare: () => {
        throw new Error('user db unavailable')
      }
    } as unknown as Database

    const originalWrite = process.stderr.write
    let captured = ''
    process.stderr.write = ((chunk: string) => {
      captured += chunk
      return true
    }) as typeof process.stderr.write

    try {
      register('bad-user', bad)
      register('good-user', good)
      runDecayJob()
      expect(importance()).toBeLessThan(0.8)
    } finally {
      process.stderr.write = originalWrite
      clearRegistry()
      closeDb()
    }

    expect(captured).toContain('Decay job failed')
    expect(captured).toContain('"userId":"bad-user"')
  })
})
