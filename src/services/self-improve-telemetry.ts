import { config } from '../config'
import { getDb } from '../db'
import { sqlIn } from '../db/utils'
import { getLogDb } from '../logging'
import { GROUNDING_TOOLS, windowStart } from './utils'

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

export function queryTelemetrySignals(): TelemetrySignals {
  const logDb = getLogDb()
  if (!logDb) return { orphanRate: 0, totalWrites: 0, activationRate: 1, draftCreates: 0, archives: 0, highHitThoughts: [], searchCreateRatio: 1, clusterOps: 0 }
  const d = getDb()
  const since7d = windowStart(7 * 86400)
  const since30d = windowStart(30 * 86400)

  const totalWritesRow = logDb
    .prepare(`SELECT COUNT(*) AS cnt FROM thought_telemetry WHERE action = 'write' AND created_at >= ?`)
    .get(since7d) as { cnt: number }

  const orphanCountRow = logDb
    .prepare(`
    SELECT COUNT(*) AS cnt FROM thought_telemetry
    WHERE action = 'write' AND created_at >= ?
      AND (prev_tool IS NULL OR prev_tool NOT IN (${sqlIn(GROUNDING_TOOLS)}))
  `)
    .get(since7d, ...GROUNDING_TOOLS) as { cnt: number }

  const totalWrites = totalWritesRow.cnt
  const orphanRate = totalWrites > 0 ? orphanCountRow.cnt / totalWrites : 0

  const draftCreatesRow = logDb
    .prepare(
      `SELECT COUNT(*) AS cnt FROM thought_telemetry WHERE action = 'write' AND tool_name = 'create_thought' AND created_at >= ?`
    )
    .get(since30d) as { cnt: number }

  const draftToActiveRow = logDb
    .prepare(
      `SELECT COUNT(*) AS cnt FROM thought_telemetry WHERE action = 'write' AND tool_name = 'update_thought' AND meta LIKE '%"status":"active"%' AND created_at >= ?`
    )
    .get(since30d) as { cnt: number }

  const archivedRow = logDb
    .prepare(
      `SELECT COUNT(*) AS cnt FROM thought_telemetry WHERE action = 'write' AND tool_name = 'archive_thought' AND created_at >= ?`
    )
    .get(since30d) as { cnt: number }

  const draftCreates = draftCreatesRow.cnt
  const activations = draftToActiveRow.cnt
  const activationRate = draftCreates > 0 ? activations / draftCreates : 1

  const searchCreateRow = logDb
    .prepare(`
    SELECT COUNT(*) AS cnt FROM thought_telemetry
    WHERE action = 'write' AND tool_name = 'create_thought'
      AND prev_tool = 'search_thoughts' AND created_at >= ?
  `)
    .get(since7d) as { cnt: number }

  const searchCreateRatio = draftCreates > 0 ? searchCreateRow.cnt / Math.max(1, draftCreates / 4) : 1

  const clusterOpsRow = logDb
    .prepare(`
    SELECT COUNT(*) AS cnt FROM thought_telemetry
    WHERE tool_name IN ('link_thoughts', 'cluster', 'auto_cluster', 'merge_thoughts')
      AND created_at >= ?
  `)
    .get(since7d) as { cnt: number }

  const highHitThoughts = d
    .prepare(
      `SELECT thought_id AS id, hit_count FROM thought_importance WHERE hit_count >= ? ORDER BY hit_count DESC LIMIT 20`
    )
    .all(config.selfImprove.hitsThreshold) as Array<{ id: string; hit_count: number }>

  return {
    orphanRate,
    totalWrites,
    activationRate,
    draftCreates,
    archives: archivedRow.cnt,
    highHitThoughts,
    searchCreateRatio,
    clusterOps: clusterOpsRow.cnt
  }
}
