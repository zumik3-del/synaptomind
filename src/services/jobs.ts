export interface IntervalJobOptions {
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
  }

  function stop(): void {
    if (timer) {
      clearInterval(timer)
      timer = null
    }
  }

  return { start, stop }
}
