import type { Database } from 'bun:sqlite'
import { getDb } from '../db'
import { config } from '../config'
import {
  createVerifyEntry,
  findThoughtsWithoutVerifyEntry,
  getVerifyEntriesPendingCheck,
  markFlagged,
  recordCheck,
  updateContentHash
} from '../db/thought_verify'
import { generateEmbedding, isEmbedderReady } from '../embedder/client'
import { getThoughtById } from './thoughts.service'
import { isOlderThanDays } from './utils'

interface VerifyStats {
  checked: number
  flagged: number
  skipped: number
}

export async function runVerifyJob(
  opts?: { enabled?: boolean; staleWarnDays?: number; embed?: (text: string) => Promise<Float32Array> },
  d: Database = getDb()
): Promise<VerifyStats> {
  const enabled = opts?.enabled ?? config.verify.enabled
  if (!enabled) return { checked: 0, flagged: 0, skipped: 0 }
  const staleDays = opts?.staleWarnDays ?? config.verify.staleWarnDays
  // Drift comparison needs a live embedder; without one the job degrades to a
  // staleness-only check (that is also how tests inject a fake embed fn).
  const embed = opts?.embed ?? (isEmbedderReady() ? generateEmbedding : null)

  // Arm the pipeline: every embedded thought gets a verify entry whose drift
  // threshold snapshots the configured default. vec_thoughts does not exist in
  // :memory: test DBs (no vec0) — tolerate and continue with existing entries.
  try {
    for (const id of findThoughtsWithoutVerifyEntry(d)) {
      createVerifyEntry(d, id, config.verify.driftThreshold)
    }
  } catch {
    // no vec_thoughts table — nothing to arm
  }

  const entries = getVerifyEntriesPendingCheck(d)
  let flagged = 0
  let checked = 0

  for (const entry of entries) {
    try {
      const thought = getThoughtById(entry.thought_id, d)
      if (!thought) {
        checked++
        continue
      }
      checked++

      const stored = getThoughtEmbedding(entry.thought_id, d)
      let drift: number | null = null
      if (embed && stored) {
        try {
          drift = cosineDistance(stored, await embed(thought.content))
        } catch (err) {
          // per-entry embedder failure — fall back to the staleness-only check
          console.error('[verify] embed failed:', entry.thought_id, err)
        }
      }

      const threshold = entry.drift_threshold > 0 ? entry.drift_threshold : config.verify.driftThreshold
      const isStale = isOlderThanDays(thought.created_at, staleDays)
      const drifted = drift !== null && drift > threshold

      if (isStale || drifted) {
        markFlagged(d, entry.thought_id, drift)
        flagged++
      } else {
        recordCheck(d, entry.thought_id, drift)
      }

      if (drift !== null) updateContentHash(d, entry.thought_id, getThoughtContentHash(d, entry.thought_id))
    } catch (err) {
      console.error('[verify] entry failed:', entry.thought_id, err)
    }
  }

  return { checked, flagged, skipped: entries.length - checked }
}

function getThoughtContentHash(db: Database, thoughtId: string): string | null {
  const row = db.prepare(`SELECT content_hash FROM thoughts WHERE id = ?`).get(thoughtId) as
    | { content_hash: string }
    | undefined
  return row?.content_hash ?? null
}

// 1 - cosine similarity, matching the vec0 cosine distance metric. Returns
// null when a distance is not defined (dimension mismatch, zero vector) —
// dimension mismatch typically means the embedding model changed.
function cosineDistance(a: Float32Array, b: Float32Array): number | null {
  if (a.length !== b.length) return null
  let dot = 0
  let normA = 0
  let normB = 0
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i]
    normA += a[i] * a[i]
    normB += b[i] * b[i]
  }
  if (normA === 0 || normB === 0) return null
  return 1 - dot / (Math.sqrt(normA) * Math.sqrt(normB))
}

function getThoughtEmbedding(thoughtId: string, db: Database): Float32Array | null {
  try {
    const row = db.prepare(`SELECT embedding FROM vec_thoughts WHERE id = ?`).get(thoughtId) as
      | { embedding: Buffer }
      | undefined
    if (!row) return null
    // third arg is the element count, not bytes (Float32Array = 4 bytes/elem)
    return new Float32Array(row.embedding.buffer as ArrayBuffer, row.embedding.byteOffset, row.embedding.byteLength / 4)
  } catch {
    return null
  }
}
