import type { Database } from 'bun:sqlite'
import { config } from '../config'
import { decayImportance } from '../db/importance'
import { insertLog } from '../logging'
import { createIntervalJob, jobDatabases } from './jobs.service'

export function runDecayJob(d?: Database): void {
  if (d) {
    decayImportance(d, config.decay.rate)
    return
  }
  for (const { userId, db } of jobDatabases()) {
    try {
      decayImportance(db, config.decay.rate)
    } catch (err) {
      insertLog('warning', 'decay', 'Decay job failed', {
        userId,
        error: err instanceof Error ? err.message : String(err)
      })
    }
  }
}

const job = createIntervalJob(
  {
    name: 'decay',
    intervalMs: config.decay.intervalMs
  },
  () => {
    runDecayJob()
  }
)

export function startDecayJob(): void {
  job.start()
}
export function stopDecayJob(): Promise<void> {
  return job.stop()
}
