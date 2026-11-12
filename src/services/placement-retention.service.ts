import { config } from '../config'
import { getDb } from '../db'
import { MS_PER_DAY } from '../utils'
import { deleteExpired } from '../db/placement-proposals'
import { deleteExpiredPreviewTokens } from '../db/preview-tokens'
import { insertLog } from '../logging/log'
import { createIntervalJob, jobDatabases } from './jobs.service'
import type { Database } from 'bun:sqlite'

export interface PlacementRetentionResult {
  proposals: number
  tokens: number
}

export function cleanupPlacementProposals(d: Database = getDb()): PlacementRetentionResult {
  const ttlDays = config.placement.proposalTtlDays

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

const onError = (err: unknown): void =>
  insertLog('warning', 'placement-retention', 'Placement retention job failed', {
    error: String(err)
  })

// One synchronous pass per tick, so the reentrancy guard in `createIntervalJob` wraps the whole tick.
const sweepAll = (): void => {
  for (const db of jobDatabases()) {
    try {
      cleanupPlacementProposals(db)
    } catch (err) {
      onError(err)
    }
  }
}

const job = createIntervalJob(
  { name: 'placement-retention', intervalMs: MS_PER_DAY, onError },
  sweepAll
)

export function startPlacementRetentionJob(): void {
  // A daily interval never fires on a host that restarts more often, so sweep once at boot.
  try {
    sweepAll()
  } catch (err) {
    onError(err)
  }
  job.start()
}
export function stopPlacementRetentionJob(): void {
  job.stop()
}
