import { config } from '../config'
import { getDb } from '../db'
import { archiveStaleLowImportance, decayImportance } from '../db/thoughts'
import { createIntervalJob } from './jobs'

export function runDecayJob(): void {
  const d = getDb()
  const rate = config.decay.rate
  decayImportance(d, rate)
  const archived = archiveStaleLowImportance(d, config.decay.archiveThreshold, config.decay.archiveMinAgeDays)
  if (archived > 0) {
    console.log(`[decay] archived ${archived} stale low-importance thoughts`)
  }
}

const job = createIntervalJob({
  name: 'decay',
  intervalMs: config.decay.intervalMs,
  onError: (err) => console.error('[decay] job error:', err)
}, () => { runDecayJob() })

export function startDecayJob(): void { job.start() }
export function stopDecayJob(): void { job.stop() }
