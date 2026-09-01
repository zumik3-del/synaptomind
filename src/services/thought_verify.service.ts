import { getDb } from '../db'
import { getVerifyEntriesPendingCheck, markFlagged, clearFlag } from '../db/thought_verify'
import { getThoughtById } from './thoughts.service'
import { isOlderThanDays } from './utils'

interface VerifyStats {
  checked: number
  flagged: number
  skipped: number
}

export async function runVerifyJob(): Promise<VerifyStats> {
  const enabled = process.env.VERIFY_ENABLED !== 'false'
  if (!enabled) return { checked: 0, flagged: 0, skipped: 0 }
  const d = getDb()
  const entries = getVerifyEntriesPendingCheck(d)
  const staleDays = parseInt(process.env.STALE_WARN_DAYS || '30', 10)
  let flagged = 0
  let checked = 0

  for (const entry of entries) {
    try {
      const thought = getThoughtById(entry.thought_id)
      if (!thought) {
        checked++
        continue
      }
      checked++

      const thoughtEmb = getThoughtEmbedding(entry.thought_id, d)
      if (!thoughtEmb) continue

      const isStale = isOlderThanDays(thought.created_at, staleDays)

      if (isStale) {
        markFlagged(d, entry.thought_id, 0)
        flagged++
      } else {
        clearFlag(d, entry.thought_id)
      }
    } catch (err) {
      console.error('[verify] entry failed:', entry.thought_id, err)
    }
  }

  return { checked, flagged, skipped: entries.length - checked }
}

function getThoughtEmbedding(thoughtId: string, db: ReturnType<typeof getDb>): Float32Array | null {
  try {
    const row = db.prepare(`SELECT embedding FROM vec_thoughts WHERE id = ?`).get(thoughtId) as
      | { embedding: Buffer }
      | undefined
    if (!row) return null
    return new Float32Array(row.embedding.buffer as ArrayBuffer, row.embedding.byteOffset, row.embedding.byteLength)
  } catch {
    return null
  }
}
