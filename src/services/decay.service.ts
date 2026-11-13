import { config } from '../config'
import { decayImportance } from '../db/importance'
import { createIntervalJob, jobDatabases } from './jobs.service'
import type { Database } from 'bun:sqlite'

const onError = (err: unknown): void => console.error('[decay] job error:', err)

export function runDecayJob(d?: Database): void {
  if (d) {
    decayImportance(d, config.decay.rate)
    return
  }
  for (const db of jobDatabases()) {
    try {
      decayImportance(db, config.decay.rate)
    } catch (err) {
      onError(err)
    }
  }
}

const job = createIntervalJob(
  {
    name: 'decay',
    intervalMs: config.decay.intervalMs,
    onError
  },
  () => {
    runDecayJob()
  }
)

export function startDecayJob(): void {
  job.start()
}
export function stopDecayJob(): void {
  job.stop()
}
