import type { Database, SQLQueryBindings } from 'bun:sqlite'
import { getThoughtTagsBatch } from './tags'
import { rowToThought } from './thoughts'
import { sqlIn } from './utils'
import type { Thought } from './thoughts'

export interface SearchOptions {
  embedding: Float32Array
  query?: string
  topK?: number
  statusFilter?: string
  projectFilter?: string
  clusterFilter?: 'only' | 'exclude'
  minImportance?: number
  excludeFlagged?: boolean
  hybrid?: boolean
  entitySearchIds?: (query: string, limit: number) => string[]
}

export interface SearchResult {
  thought: Thought
  distance: number
  similarity: number
}

interface SearchRow {
  id: string
  content: string
  status: string
  source: string | null
  project_id: string
  is_cluster: number
  is_profile: number
  created_at: string
  updated_at: string
}

function getClusterFilterSQL(filter: 'only' | 'exclude'): { sql: string; params: SQLQueryBindings[] } {
  if (filter === 'only') return { sql: 'AND t.is_cluster = 1 ', params: [] }
  return { sql: 'AND (t.is_cluster IS NULL OR t.is_cluster = 0) ', params: [] }
}

interface FilterOptions {
  statusFilter?: string
  projectFilter?: string
  clusterFilter?: 'only' | 'exclude'
  minImportance?: number
  excludeFlagged?: boolean
}

function buildFilterSQL(options: FilterOptions): { sql: string; params: SQLQueryBindings[] } {
  let sql = ''
  const params: SQLQueryBindings[] = []
  if (options.statusFilter) {
    sql += 'AND t.status = ? '
    params.push(options.statusFilter)
  }
  if (options.projectFilter) {
    sql += 'AND t.project_id = ? '
    params.push(options.projectFilter)
  }
  if (options.clusterFilter) {
    const cf = getClusterFilterSQL(options.clusterFilter)
    sql += cf.sql
    params.push(...cf.params)
  }
  if (options.minImportance !== undefined && options.minImportance > 0) {
    sql += 'AND ti.importance >= ? '
    params.push(options.minImportance)
  }
  if (options.excludeFlagged) {
    sql += 'AND NOT EXISTS (SELECT 1 FROM thought_verify tv WHERE tv.thought_id = t.id AND tv.flagged = 1) '
  }
  return { sql, params }
}

// ── FTS5 / BM25 keyword leg ─────────────────────────────────────────────────

function toFtsQuery(query: string): string {
  const tokens = query
    .split(/\s+/)
    .map(t => t.trim().replace(/^"+|"+$/g, '').replace(/["*:()^+\-[\]\\]/g, ''))
    .filter(Boolean)
    .map(t => `"${t}"`)
  return tokens.length ? tokens.join(' OR ') : '""'
}

export function bm25SearchIds(db: Database, query: string, limit: number): string[] {
  try {
    const rows = db
      .prepare(`SELECT thought_id FROM thoughts_fts WHERE thoughts_fts MATCH ? ORDER BY bm25(thoughts_fts) LIMIT ?`)
      .all(toFtsQuery(query), limit) as Array<{ thought_id: string }>
    return rows.map(r => r.thought_id)
  } catch {
    return []
  }
}

// ── Reciprocal Rank Fusion ──────────────────────────────────────────────────

const RRF_K = 60

export function rrfMerge(lists: string[][]): Array<{ id: string; score: number }> {
  const score = new Map<string, number>()
  for (const list of lists) {
    list.forEach((id, idx) => {
      score.set(id, (score.get(id) ?? 0) + 1 / (RRF_K + idx + 1))
    })
  }
  return [...score.entries()].sort((a, b) => b[1] - a[1]).map(([id, s]) => ({ id, score: s }))
}

// ── Vector leg ──────────────────────────────────────────────────────────────

function vecSearchIds(
  db: Database,
  embedding: Float32Array,
  pool: number,
  filterSql: string,
  filterParams: SQLQueryBindings[],
  topK: number
): Array<{ id: string; distance: number }> {
  const embeddingBuf = Buffer.from(embedding.buffer as ArrayBuffer, embedding.byteOffset, embedding.byteLength)
  const params: SQLQueryBindings[] = [embeddingBuf, pool, ...filterParams]
  const rows = db
    .prepare(`
      SELECT v.id, v.distance
      FROM vec_thoughts v
      INNER JOIN thoughts t ON v.id = t.id
      LEFT JOIN thought_importance ti ON v.id = ti.thought_id
      WHERE v.embedding MATCH ? AND v.k = ?
        ${filterSql}
      ORDER BY v.distance
      LIMIT ?
    `)
    .all(...params, topK) as Array<{ id: string; distance: number }>
  return rows
}

// ── Object hydration ────────────────────────────────────────────────────────

function fetchThoughtsByIds(
  db: Database,
  orderedIds: string[],
  options: SearchOptions,
  vecSimById: Map<string, number>
): SearchResult[] {
  if (orderedIds.length === 0) return []
  const ph = sqlIn(orderedIds)
  const { sql: filterSql, params } = buildFilterSQL(options)

  const rows = db
    .prepare(`
      SELECT t.*, ti.importance as _importance
      FROM thoughts t
      LEFT JOIN thought_importance ti ON t.id = ti.thought_id
      WHERE t.id IN (${ph}) ${filterSql}
    `)
    .all(...orderedIds, ...params) as Array<SearchRow & { _importance: number | null }>

  const tagMap = getThoughtTagsBatch(db, rows.map(r => r.id))
  const byId = new Map(rows.map(r => [r.id, r]))
  const out: SearchResult[] = []
  for (const id of orderedIds) {
    const r = byId.get(id)
    if (!r) continue
    const sim = vecSimById.get(id)
    const thought = rowToThought(r as unknown as Record<string, unknown>)
    thought.tags = tagMap.get(r.id) ?? []
    out.push({
      thought,
      distance: sim !== undefined ? 1 - sim : 0,
      similarity: sim !== undefined ? sim : 0
    })
  }
  return out
}

export function searchThoughts(db: Database, options: SearchOptions): SearchResult[] {
  const {
    embedding,
    query,
    topK = 10,
    hybrid = true,
    statusFilter,
    projectFilter,
    clusterFilter,
    minImportance,
    excludeFlagged,
    entitySearchIds
  } = options
  const pool = Math.min(1000, Math.max(topK * 10, topK))

  const { sql: filterSql, params: filterParams } = buildFilterSQL({
    statusFilter,
    projectFilter,
    clusterFilter,
    minImportance,
    excludeFlagged
  })

  const vecIds = embedding.length > 0
    ? vecSearchIds(db, embedding, pool, filterSql, filterParams, topK)
    : []
  const vecSimById = new Map(vecIds.map(v => [v.id, 1 - v.distance]))

  if (!hybrid || !query) {
    return fetchThoughtsByIds(
      db,
      vecIds.map(v => v.id),
      options,
      vecSimById
    )
  }

  const bm25Ids = bm25SearchIds(db, query, pool)
  const entityIds = entitySearchIds ? entitySearchIds(query, pool) : []
  const merged = rrfMerge([vecIds.map(v => v.id), bm25Ids, entityIds]).slice(0, topK)
  return fetchThoughtsByIds(
    db,
    merged.map(m => m.id),
    options,
    vecSimById
  )
}
