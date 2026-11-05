import { config } from '../config'
import { decayImportance } from '../db/importance'
import { createIntervalJob, jobDatabases } from './jobs'
import type { Database } from 'bun:sqlite'

/**
 * One decay pass: importance only.
 *
 * The auto-archive half was removed (task #1943) — it could not fire for
 * thoughts created with `is_protected = 1`, so it only archived the few
 * unprotected thoughts the decay job has no business touching.
 */

const onError = (err: unknown): void => console.error('[decay] job error:', err)

export function runDecayJob(d?: Database): void {
  if (d) {
    decayImportance(d, config.decay.rate)
    return
  }
  // Iterate the registry (or the singleton fallback) sequentially. bun:sqlite
  // is synchronous, so a single synchronous pass keeps the reentrancy guard
  // meaningful: the guard wraps this whole tick, not individual DBs.
  for (const db of jobDatabases()) {
    try {
      decayImportance(db, config.decay.rate)
    } catch (err) {
      onError(err)
    }
  }
}

const job = createIntervalJob({
  name: 'decay',
  intervalMs: config.decay.intervalMs,
  onError
}, () => { runDecayJob() })

export function startDecayJob(): void { job.start() }
export function stopDecayJob(): void { job.stop() }
