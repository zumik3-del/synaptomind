import { config } from '../config'
import { getDb } from '../db'
import { deleteExpired } from '../db/placement-proposals'
import { deleteExpiredPreviewTokens } from '../db/preview-tokens'
import { insertLog } from '../logging/log'
import { createIntervalJob } from './jobs'
import type { Database } from 'bun:sqlite'

/**
 * Expire `pending` placement proposals whose `expires_at` has passed and prune
 * terminal rows decided before the TTL cutoff (ADR §2.4). Uses the
 * `placement_proposals.deleteExpired` DB helper.
 * Returns the number of rows expired + pruned.
 */
export function cleanupPlacementProposals(d: Database = getDb()): number {
  const ttlDays = config.placement.proposalTtlDays

  let affected = 0
  if (ttlDays >= 0) {
    const now = new Date().toISOString()
    const cutoff = new Date(Date.now() - ttlDays * 86400000).toISOString()
    affected = deleteExpired(d, cutoff, now)
    if (affected > 0) {
      insertLog('info', 'placement-retention', `Expired/pruned ${affected} placement proposals`)
    }
  }

  // Sweep expired preview tokens (task #2154).
  const expiredTokens = deleteExpiredPreviewTokens(d)
  if (expiredTokens > 0) {
    insertLog('info', 'placement-retention', `Swept ${expiredTokens} expired preview tokens`)
  }

  return affected + expiredTokens
}

const job = createIntervalJob({
  name: 'placement-retention',
  intervalMs: 86400000,
  guard: () => true,
  onError: err => insertLog('warning', 'placement-retention', 'Placement retention job failed', { error: String(err) })
}, () => {
  // `cleanupPlacementProposals` already logs the affected count.
  cleanupPlacementProposals()
})

export function startPlacementRetentionJob(): void { job.start() }
export function stopPlacementRetentionJob(): void { job.stop() }
