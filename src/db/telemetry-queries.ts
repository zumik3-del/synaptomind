import type { Database } from 'bun:sqlite'
import { sqlIn } from './utils'

/**
 * Read-tool names that ground a write (i.e. the agent consulted memory before
 * persisting). A write whose `prev_tool` is absent from this list is an
 * "orphan write" (see issue #17).
 */
const GROUNDING_TOOLS = [
  'search_thoughts',
  'get_thought',
  'get_thought_timeline',
  'recall_clusters',
  'get_context',
  'get_thought_graph',
  'list_projects',
  'get_chain',
  'get_frontier',
  'get_slots',
  'list_smart_notes',
  'eval_smart_notes',
  'get_profile'
]

interface PatternsRow {
  prev_tool: string | null
  tool_name: string
  count: number
}

interface FrequencyRow {
  action: string
  count: number
}

interface OrphanWritesAggregate {
  total: number
  orphan_count: number
}

interface OrphanWritesDetail {
  id: string
  tool_name: string
  prev_tool: string | null
  query: string | null
  thought_id: string | null
  created_at: string
}

interface DraftLifecycleRow {
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

// ── Self-improve signal counts ───────────────────────────────────────────────

export function countWriteEvents(db: Database, since: string): number {
  const row = db
    .prepare(`SELECT COUNT(*) AS cnt FROM thought_telemetry WHERE action = 'write' AND created_at >= ?`)
    .get(since) as { cnt: number }
  return row.cnt
}

export function countOrphanWriteEvents(db: Database, since: string): number {
  const row = db
    .prepare(`
      SELECT COUNT(*) AS cnt FROM thought_telemetry
      WHERE action = 'write' AND created_at >= ?
        AND (prev_tool IS NULL OR prev_tool NOT IN (${sqlIn(GROUNDING_TOOLS)}))
    `)
    .get(since, ...GROUNDING_TOOLS) as { cnt: number }
  return row.cnt
}

export function countSearchCreateEvents(db: Database, since: string): number {
  const row = db
    .prepare(`
      SELECT COUNT(*) AS cnt FROM thought_telemetry
      WHERE action = 'write' AND tool_name = 'create_thought'
        AND prev_tool = 'search_thoughts' AND created_at >= ?
    `)
    .get(since) as { cnt: number }
  return row.cnt
}

export function countClusterOpEvents(db: Database, since: string): number {
  const row = db
    .prepare(`
      SELECT COUNT(*) AS cnt FROM thought_telemetry
      WHERE tool_name IN ('link_thoughts', 'cluster', 'auto_cluster', 'merge_thoughts')
        AND created_at >= ?
    `)
    .get(since) as { cnt: number }
  return row.cnt
}
