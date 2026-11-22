import type { Database } from 'bun:sqlite'
import { type Config, config } from '../config'
import { getDb } from '../db'
import { deleteExpired } from '../db/placement-proposals'
import { deleteExpiredPreviewTokens } from '../db/preview-tokens'
import { insertLog } from '../logging/log'
import { MS_PER_DAY } from '../utils'
import { createIntervalJob, jobDatabases } from './jobs.service'

export interface PlacementRetentionResult {
  proposals: number
  tokens: number
}

export function cleanupPlacementProposals(
  d: Database = getDb(),
  cfg: Config = config
): PlacementRetentionResult {
  const ttlDays = cfg.placement.proposalTtlDays

  let proposals = 0
  if (ttlDays >= 0) {
    const now = new Date().toISOString()
    const cutoff = new Date(Date.now() - ttlDays * MS_PER_DAY).toISOString()
    proposals = deleteExpired(d, cutoff, now)
    if (proposals > 0) {
      insertLog('info', 'placement-retention', `Expired/pruned ${proposals} placement proposals`)
    }
  }

  const tokens = deleteExpiredPreviewTokens(d)
  if (tokens > 0) {
    insertLog('info', 'placement-retention', `Swept ${tokens} expired preview tokens`)
  }

  return { proposals, tokens }
}

const sweepAll = (): void => {
  for (const { userId, db } of jobDatabases()) {
    try {
      cleanupPlacementProposals(db)
    } catch (err) {
      insertLog('warning', 'placement-retention', 'Placement retention job failed', {
        userId,
        error: err instanceof Error ? err.message : String(err)
      })
    }
  }
}

const job = createIntervalJob({ name: 'placement-retention', intervalMs: MS_PER_DAY }, sweepAll)

export function startPlacementRetentionJob(): void {
  job.start()
}
export function stopPlacementRetentionJob(): Promise<void> {
  return job.stop()
}
