import type { Database } from 'bun:sqlite'
import { getDb, listUserDatabases } from '../context/container'

interface IntervalJobOptions {
  name: string
  intervalMs: number
  guard?: () => boolean
  onError?: (err: unknown) => void
}

export function jobDatabases(): Database[] {
  const entries = listUserDatabases()
  if (entries.length > 0) return entries.map(entry => entry.db)
  try {
    return [getDb()]
  } catch {
    return []
  }
}

export function createIntervalJob(
  opts: IntervalJobOptions,
  fn: () => void | Promise<void>
): {
  start: () => void
  stop: () => void
} {
  let timer: ReturnType<typeof setInterval> | null = null
  let running = false

  function start(): void {
    if (timer) return
    if (opts.guard && !opts.guard()) return
    timer = setInterval(() => {
      if (running) return
      running = true
      try {
        const result = fn()
        if (result instanceof Promise) {
          result
            .catch(err => {
              opts.onError?.(err)
            })
            .finally(() => {
              running = false
            })
          return
        }
      } catch (err) {
        opts.onError?.(err)
      }
      running = false
    }, opts.intervalMs)
    timer.unref()
  }

  function stop(): void {
    if (timer) {
      clearInterval(timer)
      timer = null
    }
    running = false
  }

  return { start, stop }
}
