import { config } from '../config'
import { getDb } from '../db'
import { deleteExpired } from '../db/placement-proposals'
import { insertLog } from '../logging/log'
import { createIntervalJob } from './jobs'
import type { Database } from 'bun:sqlite'

/**
 * Expire `pending` placement proposals whose `expires_at` has passed and prune
 * terminal rows decided before the TTL cutoff (ADR §2.4). Reuses the existing
 * TTL-cleanup pattern and the `placement_proposals.deleteExpired` DB helper.
 * Returns the number of rows expired + pruned.
 */
export function cleanupPlacementProposals(d: Database = getDb()): number {
  const ttlDays = config.placement.proposalTtlDays

  if (ttlDays < 0) return 0

  const now = new Date().toISOString()
  const cutoff = new Date(Date.now() - ttlDays * 86400000).toISOString()
  const affected = deleteExpired(d, cutoff, now)

  if (affected > 0) {
    insertLog('info', 'placement-retention', `Expired/pruned ${affected} placement proposals`)
  }

  return affected
}

const job = createIntervalJob({
  name: 'placement-retention',
  intervalMs: config.ttl.cleanupIntervalMs,
  guard: () => config.placement.proposalTtlDays >= 0,
  onError: (err) => console.error('[placement-retention] job error:', err)
}, () => {
  const affected = cleanupPlacementProposals()
  if (affected > 0) {
    console.error(`[placement-retention] expired/pruned ${affected} placement proposals`)
  }
})

export function startPlacementRetentionJob(): void { job.start() }
export function stopPlacementRetentionJob(): void { job.stop() }
