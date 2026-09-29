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

  function start(): void {
    // Starting an already-running job would overwrite the handle and orphan the
    // previous timer — `stop` could then only ever clear the last one.
    if (timer) return
    if (opts.guard && !opts.guard()) return
    timer = setInterval(() => {
      try {
        const result = fn()
        if (result instanceof Promise) {
          result.catch(err => {
            opts.onError?.(err)
          })
        }
      } catch (err) {
        opts.onError?.(err)
      }
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
  }

  return { start, stop }
}
