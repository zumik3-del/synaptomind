import { config } from '../config'
import { getDb } from '../db'
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

const sweep = (): void => {
  // `cleanupPlacementProposals` already logs the affected counts.
  cleanupPlacementProposals()
}

const job = createIntervalJob({ name: 'placement-retention', intervalMs: 86400000, onError }, sweep)

export function startPlacementRetentionJob(): void {
  // Sweep once at boot: the interval is daily, so a host that restarts more
  // often than that would otherwise never prune anything.
  try {
    sweep()
  } catch (err) {
    onError(err)
  }
  job.start()
}
export function stopPlacementRetentionJob(): void { job.stop() }
