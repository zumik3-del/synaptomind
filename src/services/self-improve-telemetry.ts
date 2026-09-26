import { config } from '../config'
import { getDb } from '../db'
import { findHighHitThoughts } from '../db/thoughts'
import {
  countClusterOpEvents,
  countOrphanWriteEvents,
  countSearchCreateEvents,
  countWriteEvents,
  queryDraftLifecycleDetailed
} from '../db/telemetry-queries'
import { getLogDb } from '../logging'
import { windowStart } from './utils'
import type { Database } from 'bun:sqlite'

export interface TelemetrySignals {
  orphanRate: number
  totalWrites: number
  activationRate: number
  draftCreates: number
  archives: number
  highHitThoughts: Array<{ id: string; hit_count: number }>
  searchCreateRatio: number
  clusterOps: number
}

export function queryTelemetrySignals(d: Database = getDb()): TelemetrySignals {
  const logDb = getLogDb()
  if (!logDb) return { orphanRate: 0, totalWrites: 0, activationRate: 1, draftCreates: 0, archives: 0, highHitThoughts: [], searchCreateRatio: 1, clusterOps: 0 }
  const since7d = windowStart(7 * 86400)
  const since30d = windowStart(30 * 86400)

  const totalWrites = countWriteEvents(logDb, since7d)
  const orphanCount = countOrphanWriteEvents(logDb, since7d)
  const orphanRate = totalWrites > 0 ? orphanCount / totalWrites : 0

  const lifecycle = queryDraftLifecycleDetailed(logDb, since30d)
  const draftCreates = lifecycle.draft_creates
  const activations = lifecycle.updates
  const activationRate = draftCreates > 0 ? activations / draftCreates : 1

  const searchCreateCount = countSearchCreateEvents(logDb, since7d)
  const searchCreateRatio = draftCreates > 0 ? searchCreateCount / Math.max(1, draftCreates / 4) : 1

  const clusterOps = countClusterOpEvents(logDb, since7d)

  const highHitThoughts = findHighHitThoughts(d, config.selfImprove.hitsThreshold)

  return {
    orphanRate,
    totalWrites,
    activationRate,
    draftCreates,
    archives: lifecycle.archives,
    highHitThoughts,
    searchCreateRatio,
    clusterOps
  }
}
