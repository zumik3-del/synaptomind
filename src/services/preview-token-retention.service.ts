import type { Database } from 'bun:sqlite'
import { deleteExpiredPreviewTokens } from '../db/preview-tokens'
import { insertLog } from '../logging/log'
import { MS_PER_DAY } from '../utils'
import { createIntervalJob, jobDatabases } from './jobs.service'

export function cleanupExpiredPreviewTokens(d: Database): number {
  const tokens = deleteExpiredPreviewTokens(d)
  if (tokens > 0) {
    insertLog('info', 'preview-token-retention', `Swept ${tokens} expired preview tokens`)
  }
  return tokens
}

const sweepAll = (): void => {
  for (const { userId, db } of jobDatabases()) {
    try {
      cleanupExpiredPreviewTokens(db)
    } catch (err) {
      insertLog('warning', 'preview-token-retention', 'Preview token retention job failed', {
        userId,
        error: err instanceof Error ? err.message : String(err)
      })
    }
  }
}

const job = createIntervalJob({ name: 'preview-token-retention', intervalMs: MS_PER_DAY }, sweepAll)

export function startPreviewTokenRetentionJob(): void {
  job.start()
}
export function stopPreviewTokenRetentionJob(): Promise<void> {
  return job.stop()
}
