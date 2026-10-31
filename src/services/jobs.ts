interface IntervalJobOptions {
  name: string
  intervalMs: number
  guard?: () => boolean
  onError?: (err: unknown) => void
}

export function createIntervalJob(opts: IntervalJobOptions, fn: () => void | Promise<void>): {
  start: () => void
  stop: () => void
} {
  let timer: ReturnType<typeof setInterval> | null = null
  // Reentrancy guard: a tick that is still running when the next interval fires
  // is skipped instead of being overlapped, so a slow job cannot pile up.
  let running = false

  function start(): void {
    // Starting an already-running job would overwrite the handle and orphan the
    // previous timer — `stop` could then only ever clear the last one.
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
    // Do not let the interval keep the event loop alive on its own; the
    // process should be free to exit once real work (server, stdio) is done.
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
