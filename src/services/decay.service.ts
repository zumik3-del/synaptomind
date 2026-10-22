import { config } from '../config'
import { getDb } from '../db'
import { decayImportance } from '../db/importance'
import { createIntervalJob } from './jobs'
import type { Database } from 'bun:sqlite'

/**
 * One decay pass: importance only.
 *
 * The auto-archive half was removed (task #1943) — it could not fire for
 * thoughts created with `is_protected = 1`, so it only archived the few
 * unprotected thoughts the decay job has no business touching.
 */
export function runDecayJob(d: Database = getDb()): void {
  decayImportance(d, config.decay.rate)
}

const job = createIntervalJob({
  name: 'decay',
  intervalMs: config.decay.intervalMs,
  onError: (err) => console.error('[decay] job error:', err)
}, () => { runDecayJob() })

export function startDecayJob(): void { job.start() }
export function stopDecayJob(): void { job.stop() }
