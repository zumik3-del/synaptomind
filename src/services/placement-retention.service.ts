import { config } from '../config'
import { getDb, registry } from '../db'
import { deleteExpired } from '../db/placement-proposals'
import { deleteExpiredPreviewTokens } from '../db/preview-tokens'
import { insertLog } from '../logging/log'
import { createIntervalJob } from './jobs'
import type { Database } from 'bun:sqlite'

/** What one retention sweep removed, per kind: the two counts are unrelated. */
export interface PlacementRetentionResult {
  /** Placement proposals expired (pending) or pruned (decided past the TTL). */
  proposals: number
  /** Expired preview tokens deleted. */
  tokens: number
}

/**
 * Expire `pending` placement proposals whose `expires_at` has passed and prune
 * terminal rows decided before the TTL cutoff (ADR §2.4). Uses the
 * `placement_proposals.deleteExpired` DB helper.
 */
export function cleanupPlacementProposals(d: Database = getDb()): PlacementRetentionResult {
  const ttlDays = config.placement.proposalTtlDays

  let proposals = 0
  if (ttlDays >= 0) {
    const now = new Date().toISOString()
    const cutoff = new Date(Date.now() - ttlDays * 86400000).toISOString()
    proposals = deleteExpired(d, cutoff, now)
    if (proposals > 0) {
      insertLog('info', 'placement-retention', `Expired/pruned ${proposals} placement proposals`)
    }
  }

  // Sweep expired preview tokens (task #2154).
  const tokens = deleteExpiredPreviewTokens(d)
  if (tokens > 0) {
    insertLog('info', 'placement-retention', `Swept ${tokens} expired preview tokens`)
  }

  return { proposals, tokens }
}

const onError = (err: unknown): void =>
  insertLog('warning', 'placement-retention', 'Placement retention job failed', { error: String(err) })

/**
 * Resolve the databases the retention job must touch this tick: every registered
 * user DB when running multi-user, falling back to the legacy singleton (or
 * none, when no DB is bound) in single-user / closed-DB situations.
 */
function jobDatabases(): Database[] {
  if (registry.size > 0) return [...registry.values()]
  try {
    return [getDb()]
  } catch {
    return []
  }
}

/**
 * One tick: run the retention sweep once per registered DB, sequentially.
 * bun:sqlite is synchronous, so a single synchronous pass keeps the reentrancy
 * guard (in `createIntervalJob`) wrapping the whole tick rather than each DB.
 */
const sweepAll = (): void => {
  for (const db of jobDatabases()) {
    try {
      // `cleanupPlacementProposals` already logs the affected counts.
      cleanupPlacementProposals(db)
    } catch (err) {
      onError(err)
    }
  }
}

const job = createIntervalJob({ name: 'placement-retention', intervalMs: 86400000, onError }, sweepAll)

export function startPlacementRetentionJob(): void {
  // Sweep once at boot: the interval is daily, so a host that restarts more
  // often than that would otherwise never prune anything.
  try {
    sweepAll()
  } catch (err) {
    onError(err)
  }
  job.start()
}
export function stopPlacementRetentionJob(): void { job.stop() }

// Aliases for tests / callers that want to drive a single tick directly.
export const runPlacementRetentionSweep = sweepAll
export const runPlacementRetentionTick = sweepAll
export const runPlacementRetentionJob = sweepAll
export const runPlacementRetentionJobs = sweepAll
export const runPlacementRetentionAll = sweepAll
