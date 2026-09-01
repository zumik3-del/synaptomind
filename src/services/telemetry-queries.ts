import type { Database } from 'bun:sqlite'
import { sqlIn } from '../db/utils'
import { GROUNDING_TOOLS } from './utils'

export interface PatternsRow {
  prev_tool: string | null
  tool_name: string
  count: number
}

export interface FrequencyRow {
  action: string
  count: number
}

export interface OrphanWritesAggregate {
  total: number
  orphan_count: number
}

export interface OrphanWritesDetail {
  id: string
  tool_name: string
  prev_tool: string | null
  query: string | null
  thought_id: string | null
  created_at: string
}

export interface DraftLifecycleRow {
  action: string
  count: number
}

export function queryPatterns(db: Database, since: string, limit: number): PatternsRow[] {
  return db.prepare(`
    SELECT prev_tool, tool_name, COUNT(*) as count
    FROM thought_telemetry
    WHERE created_at >= ? AND prev_tool IS NOT NULL
    GROUP BY prev_tool, tool_name
    ORDER BY count DESC
    LIMIT ?
  `).all(since, limit) as PatternsRow[]
}

export function queryFrequency(db: Database, since: string, limit: number): FrequencyRow[] {
  return db.prepare(`
    SELECT action, COUNT(*) as count
    FROM thought_telemetry
    WHERE created_at >= ?
    GROUP BY action
    ORDER BY count DESC
    LIMIT ?
  `).all(since, limit) as FrequencyRow[]
}

export function queryOrphanWritesAggregate(db: Database, since: string): OrphanWritesAggregate {
  return db.prepare(`
    SELECT COUNT(*) as total,
           SUM(CASE WHEN prev_tool NOT IN (${sqlIn(GROUNDING_TOOLS)}) THEN 1 ELSE 0 END) as orphan_count
    FROM thought_telemetry
    WHERE created_at >= ? AND action IN ('create', 'update')
  `).get(...GROUNDING_TOOLS, since) as OrphanWritesAggregate
}

export function queryOrphanWritesDetail(db: Database, since: string, limit: number): OrphanWritesDetail[] {
  return db.prepare(`
    SELECT id, tool_name, prev_tool, query, thought_id, created_at
    FROM thought_telemetry
    WHERE action = 'write'
      AND created_at >= ?
      AND (prev_tool IS NULL OR prev_tool NOT IN (${sqlIn(GROUNDING_TOOLS)}))
    ORDER BY created_at DESC
    LIMIT ?
  `).all(since, ...GROUNDING_TOOLS, limit) as OrphanWritesDetail[]
}

export function queryDraftLifecycle(db: Database, since: string): DraftLifecycleRow[] {
  return db.prepare(`
    SELECT action, COUNT(*) as count
    FROM thought_telemetry
    WHERE created_at >= ? AND tool_name = 'thought'
    GROUP BY action
    ORDER BY count DESC
  `).all(since) as DraftLifecycleRow[]
}

export function queryDraftLifecycleDetailed(db: Database, since: string): {
  draft_creates: number
  updates: number
  archives: number
} {
  const draftCreates = db.prepare(`
    SELECT COUNT(*) AS cnt FROM thought_telemetry
    WHERE action = 'write' AND tool_name = 'create_thought' AND created_at >= ?
  `).get(since) as { cnt: number }

  const draftToActive = db.prepare(`
    SELECT COUNT(*) AS cnt FROM thought_telemetry
    WHERE action = 'write' AND tool_name = 'update_thought'
      AND meta LIKE '%"status":"active"%' AND created_at >= ?
  `).get(since) as { cnt: number }

  const archived = db.prepare(`
    SELECT COUNT(*) AS cnt FROM thought_telemetry
    WHERE action = 'write' AND tool_name = 'archive_thought' AND created_at >= ?
  `).get(since) as { cnt: number }

  return {
    draft_creates: draftCreates.cnt,
    updates: draftToActive.cnt,
    archives: archived.cnt
  }
}
