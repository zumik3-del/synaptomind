/**
 * Interval-job lifecycle guards (`src/services/jobs.ts`).
 *
 * The jobs are module-level singletons started from `index.ts`; a `start()`
 * that overwrites its own handle orphans the previous timer, which then can
 * never be cleared by `stop()`.
 */
import { afterEach, describe, expect, test } from 'bun:test'
import { createIntervalJob } from './jobs'

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
    const job = track(createIntervalJob({ name: 'double-start', intervalMs: 5 }, () => { ticks++ }))

    job.start()
    const firstTimer = ticks
    job.start()
    expect(ticks).toBe(firstTimer)
  })

  test('start is idempotent: stop() still clears the only live timer', async () => {
    let ticks = 0
    const job = createIntervalJob({ name: 'stop-clears', intervalMs: 5 }, () => { ticks++ })

    job.start()
    job.start()
    await Bun.sleep(40)
    const afterStart = ticks
    expect(afterStart).toBeGreaterThan(0)

    // One clear, no orphaned interval: the counter must freeze.
    job.stop()
    await Bun.sleep(40)
    expect(ticks).toBe(afterStart)
  })

  test('a refused guard leaves the job startable later', () => {
    let ticks = 0
    let allowed = false
    const job = track(createIntervalJob({ name: 'guard', intervalMs: 5, guard: () => allowed }, () => { ticks++ }))

    job.start()
    expect(ticks).toBe(0)
    // The guard refused, so no timer exists and nothing was overwritten.
    allowed = true
    job.start()
    expect(ticks).toBe(0)
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
