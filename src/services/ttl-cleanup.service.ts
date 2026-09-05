import { config } from '../config'
import { getDb } from '../db'
import { deleteThought } from '../db/thoughts'
import { insertLog } from '../logging/log'
import { createIntervalJob } from './jobs'

export interface CleanupResult {
  deleted: number
  ids: string[]
}

export function cleanupArchivedThoughts(dryRun = false): CleanupResult {
  const d = getDb()
  const ttlDays = config.ttl.archivedTtlDays

  if (ttlDays < 0) return { deleted: 0, ids: [] }

  const cutoff = new Date(Date.now() - ttlDays * 86400000).toISOString()
  const rows = d
    .prepare(`SELECT id FROM thoughts WHERE status = 'archived' AND archived_at IS NOT NULL AND archived_at < ?`)
    .all(cutoff) as { id: string }[]

  if (rows.length === 0) return { deleted: 0, ids: [] }

  const ids = rows.map(r => r.id)

  if (dryRun) return { deleted: ids.length, ids }

  let deleted = 0
  for (const id of ids) {
    if (deleteThought(d, id)) deleted++
  }

  if (deleted > 0) {
    insertLog('info', 'ttl-cleanup', `Deleted ${deleted} expired archived thoughts`)
  }

  return { deleted, ids }
}

const job = createIntervalJob({
  name: 'ttl-cleanup',
  intervalMs: config.ttl.cleanupIntervalMs,
  guard: () => config.ttl.archivedTtlDays >= 0,
  onError: (err) => console.error('[ttl-cleanup] job error:', err)
}, () => {
  const result = cleanupArchivedThoughts()
  if (result.deleted > 0) {
    console.log(`[ttl-cleanup] deleted ${result.deleted} expired archived thoughts`)
  }
})

export function startTtlCleanupJob(): void { job.start() }
export function stopTtlCleanupJob(): void { job.stop() }
