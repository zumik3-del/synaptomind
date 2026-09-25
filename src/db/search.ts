import type { Database, SQLQueryBindings } from 'bun:sqlite'
import type { GraphStanding } from './graph-annotations'
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

/** Search legs that can contribute a hit, in the fixed `match_source` order. */
export type SearchMatchSource = 'vector' | 'bm25' | 'entity'

export interface SearchResult {
  thought: Thought
  distance: number
  similarity: number
  /**
   * Reciprocal Rank Fusion score from the hybrid merge (higher = more
   * relevant). Present only when fusion ran — i.e. the hybrid path with a
   * query and a non-empty merge; absent on the vector-only path.
   */
  rrf_score?: number
  /**
   * FTS5 BM25 relevance score, present only for hits matched by the keyword
   * leg. Sign convention: higher = more relevant (the raw FTS5 `bm25()` value
   * is negative, so it is exposed negated).
   */
  bm25_score?: number
  /**
   * Search legs that matched this thought, always present, in the fixed order
   * `vector`, `bm25`, `entity`. The vector-only path returns `['vector']`.
   */
  match_source: SearchMatchSource[]
  /** Graph standing; present only when the caller enables graph annotation. */
  standing?: GraphStanding
  /** Sources of incoming `replaces` edges (this thought is superseded). */
  superseded_by?: string[]
  /** `contradicts` partners (either direction, symmetric edge type). */
  contradicted_by?: string[]
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

interface ScoredId {
  id: string
  /** Relevance score, higher = more relevant (raw FTS5 `bm25()` negated). */
  score: number
}

/**
 * Internal scored BM25 leg. Exposes the raw FTS5 `bm25()` value negated so the
 * public `bm25_score` follows "higher = more relevant"; the ordering (FTS5
 * returns more negative for more relevant rows) is unchanged.
 */
function bm25ScoredIds(db: Database, query: string, limit: number): ScoredId[] {
  try {
    const rows = db
      .prepare(`
        SELECT thought_id, bm25(thoughts_fts) AS score
        FROM thoughts_fts
        WHERE thoughts_fts MATCH ?
        ORDER BY bm25(thoughts_fts)
        LIMIT ?
      `)
      .all(toFtsQuery(query), limit) as Array<{ thought_id: string; score: number }>
    return rows.map(r => ({ id: r.thought_id, score: -r.score }))
  } catch (err) {
    console.debug('[search] bm25 search failed:', err)
    return []
  }
}

export function bm25SearchIds(db: Database, query: string, limit: number): string[] {
  return bm25ScoredIds(db, query, limit).map(r => r.id)
}

function bm25ScoredIdsFiltered(
  db: Database,
  query: string,
  limit: number,
  filterSql: string,
  filterParams: SQLQueryBindings[]
): ScoredId[] {
  if (!filterSql) return bm25ScoredIds(db, query, limit)
  try {
    const oversample = Math.min(1000, limit * 3)
    const rows = db
      .prepare(`
        SELECT fts.thought_id, fts.score
        FROM (
          SELECT thought_id, bm25(thoughts_fts) AS score
          FROM thoughts_fts
          WHERE thoughts_fts MATCH ?
          ORDER BY bm25(thoughts_fts)
          LIMIT ?
        ) fts
        INNER JOIN thoughts t ON fts.thought_id = t.id
        LEFT JOIN thought_importance ti ON fts.thought_id = ti.thought_id
        WHERE 1=1 ${filterSql}
        LIMIT ?
      `)
      .all(toFtsQuery(query), oversample, ...filterParams, limit) as Array<{ thought_id: string; score: number }>
    return rows.map(r => ({ id: r.thought_id, score: -r.score }))
  } catch {
    return bm25ScoredIds(db, query, limit)
  }
}

export function bm25SearchIdsFiltered(
  db: Database,
  query: string,
  limit: number,
  filterSql: string,
  filterParams: SQLQueryBindings[]
): string[] {
  return bm25ScoredIdsFiltered(db, query, limit, filterSql, filterParams).map(r => r.id)
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
  try {
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
  } catch (err) {
    console.debug('[search] vec search failed:', err)
    return []
  }
}

// ── Object hydration ────────────────────────────────────────────────────────

interface SearchScoreContext {
  vecSimById: Map<string, number>
  bm25ScoreById: Map<string, number>
  rrfScoreById: Map<string, number>
  entityIds: Set<string>
}

function fetchThoughtsByIds(
  db: Database,
  orderedIds: string[],
  options: SearchOptions,
  scores: SearchScoreContext
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
    const sim = scores.vecSimById.get(id)
    const bm25 = scores.bm25ScoreById.get(id)
    const rrf = scores.rrfScoreById.get(id)
    const thought = rowToThought(r as unknown as Record<string, unknown>)
    thought.tags = tagMap.get(r.id) ?? []

    // Fixed leg order: vector, bm25, entity.
    const matchSource: SearchMatchSource[] = []
    if (sim !== undefined) matchSource.push('vector')
    if (bm25 !== undefined) matchSource.push('bm25')
    if (scores.entityIds.has(id)) matchSource.push('entity')

    const result: SearchResult = {
      thought,
      distance: sim !== undefined ? 1 - sim : 0,
      similarity: sim !== undefined ? sim : 0,
      match_source: matchSource
    }
    if (rrf !== undefined) result.rrf_score = rrf
    if (bm25 !== undefined) result.bm25_score = bm25
    out.push(result)
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
      { vecSimById, bm25ScoreById: new Map(), rrfScoreById: new Map(), entityIds: new Set() }
    )
  }

  const bm25Scored = filterSql
    ? bm25ScoredIdsFiltered(db, query, pool, filterSql, filterParams)
    : bm25ScoredIds(db, query, pool)
  const bm25ScoreById = new Map(bm25Scored.map(r => [r.id, r.score]))
  const entityIds = entitySearchIds ? entitySearchIds(query, pool) : []
  const merged = rrfMerge([vecIds.map(v => v.id), bm25Scored.map(r => r.id), entityIds]).slice(0, topK)
  const rrfScoreById = new Map(merged.map(m => [m.id, m.score]))
  return fetchThoughtsByIds(
    db,
    merged.map(m => m.id),
    options,
    { vecSimById, bm25ScoreById, rrfScoreById, entityIds: new Set(entityIds) }
  )
}
