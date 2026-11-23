import { insertLog } from './logging'

interface IntervalJobOptions {
  name: string
  intervalMs: number
  guard?: () => boolean
  onError?: (err: unknown) => void
  unref?: boolean
}

interface IntervalJob {
  start: () => void
  stop: () => Promise<void>
}

function describe(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
}

export function createIntervalJob(
  opts: IntervalJobOptions,
  fn: () => void | Promise<void>
): IntervalJob {
  let timer: ReturnType<typeof setInterval> | null = null
  let running = false
  let inFlight: Promise<void> | null = null

  function fail(err: unknown): void {
    insertLog('warning', 'jobs', `Interval job failed: ${opts.name}`, {
      job: opts.name,
      error: describe(err)
    })
    opts.onError?.(err)
  }

  function run(): void {
    if (running) return
    running = true
    try {
      const result = fn()
      if (result instanceof Promise) {
        const current: Promise<void> = result.catch(fail).finally(() => {
          running = false
          if (inFlight === current) inFlight = null
        })
        inFlight = current
        return
      }
    } catch (err) {
      fail(err)
    }
    running = false
  }

  function start(): void {
    if (timer) return
    if (opts.guard && !opts.guard()) return
    insertLog('debug', 'jobs', `Interval job started: ${opts.name}`, {
      intervalMs: opts.intervalMs
    })
    run()
    const armed = setInterval(run, opts.intervalMs)
    timer = armed
    if (opts.unref !== false) (armed as { unref?: () => void }).unref?.()
  }

  async function stop(): Promise<void> {
    if (timer) {
      clearInterval(timer)
      timer = null
      insertLog('debug', 'jobs', `Interval job stopped: ${opts.name}`)
    }
    if (inFlight) await inFlight
  }

  return { start, stop }
}
