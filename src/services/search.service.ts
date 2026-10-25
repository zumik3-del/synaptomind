import { getClusterForThoughtBatch } from '../db/cluster-edges'
import { getDb } from '../db'
import { annotateGraphStanding, type GraphStanding } from '../db/graph-annotations'
import { isStrongMatch, type SearchResult, searchThoughts as dbSearchThoughts } from '../db/search'
import { getThoughtTagsBatch } from '../db/tags'
import { getThought } from '../db/thoughts'
import type { Database } from 'bun:sqlite'
import { generateEmbedding } from '../embedder/client'
import { parseTags } from '../utils'
import { normalizeSearchOptions } from './search-normalize'

const EMBEDDING_TIMEOUT_MS = 5_000

/**
 * Rank used by `orderByStanding`: lower is better, so every `current` row
 * precedes the contested rows while the incoming relevance order is preserved
 * within each standing group.
 */
const STANDING_RANK: Record<GraphStanding, number> = {
  current: 0,
  contradicted: 1,
  superseded: 2
}

async function generateEmbeddingWithFallback(query: string): Promise<Float32Array> {
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    return await Promise.race([
      generateEmbedding(query),
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error('Embedding timeout')), EMBEDDING_TIMEOUT_MS)
      })
    ])
  } catch (err) {
    console.error('[search] embedding generation failed, falling back to BM25:', err instanceof Error ? err.message : err)
    return new Float32Array(0)
  } finally {
    if (timer) clearTimeout(timer)
  }
}

export type SupersessionMode = 'off' | 'flag' | 'suppress'
export type ContradictionMode = 'off' | 'flag'

export interface SearchServiceOptions {
  query: string
  topK?: number
  statusFilter?: string
  projectFilter?: string
  tagFilter?: string
  clusterFilter?: 'only' | 'exclude'
  minImportance?: number
  hybrid?: boolean
  /** Superseded thoughts: `off` (no annotation), `flag` (default), `suppress`. */
  supersessionMode?: SupersessionMode
  /** Contradicted thoughts: `off` or `flag` (default). Never suppressed. */
  contradictionMode?: ContradictionMode
  /**
   * Precomputed query embedding. When set the embedder is not called — the eval
   * harness and tests inject a deterministic vector here. Production callers
   * leave it unset.
   */
  embedding?: Float32Array
  /**
   * Opt-in recency boost weight, clamped to `[0, 1]` (non-finite/undefined →
   * `0`). `0` (default) preserves relevance-only ranking byte-identically.
   */
  recencyWeight?: number
  /**
   * Decay half-life in days, clamped to `[1, 3650]` (non-finite/undefined or
   * `<= 0` → `30`). Only meaningful when `recencyWeight > 0`.
   */
  recencyHalfLifeDays?: number
  /**
   * Opt-in relevance gate, clamped to `[0, 1]` (default `0`). With `0` the
   * result set/order is byte-identical to the ungated search. With `> 0` a
   * result is kept only when it is a strong match
   * (`match_source` contains `bm25`, or contains `vector` with
   * `similarity >= minRelevance`); the candidate pool is widened so `topK`
   * survivors are still reachable.
   */
  minRelevance?: number
  /**
   * Override for the `low_confidence` cosine floor, clamped to `[0, 1]`. When
   * omitted the configured `search.confidence.vectorFloor` is used. Intended for
   * tests and config overrides; production callers leave it unset.
   */
  confidenceFloor?: number
}

export interface GroupedResult {
  thought?: SearchResult['thought']
  cluster?: { id: string; content: string }
  items?: SearchResult[]
}

export async function searchThoughts(options: SearchServiceOptions, d: Database = getDb()): Promise<SearchResult[]> {
  const {
    topK,
    minImportance,
    minRelevance,
    confidenceFloor,
    candidateK,
    recencyWeight,
    recencyHalfLifeDays
  } = normalizeSearchOptions(options)
  const embedding = options.embedding ?? (await generateEmbeddingWithFallback(options.query))
  const results = dbSearchThoughts(d, {
    embedding,
    query: options.query,
    topK: candidateK,
    statusFilter: options.statusFilter,
    projectFilter: options.projectFilter,
    clusterFilter: options.clusterFilter,
    minImportance,
    hybrid: options.hybrid,
    recencyWeight,
    recencyHalfLifeDays,
    confidenceFloor
  })

  const filtered = options.tagFilter
    ? filterByTags(results, options.tagFilter, d)
    : results
  const standing = applyGraphStanding(filtered, options, d)
  // Gate after standing annotation (a suppressed row is already gone) and
  // before the final `topK` slice; the DB-slice overfetch above backfills it.
  const gated = minRelevance > 0 ? standing.filter(r => isStrongMatch(r, minRelevance)) : standing
  return gated.length > topK ? gated.slice(0, topK) : gated
}

/**
 * ADR #142, item D2: attach graph standing to results after tag filtering and
 * before post-processing, so primer hoisting can never promote a suppressed
 * (superseded) thought. `suppress` drops superseded rows; `flag` keeps them
 * annotated. Contradicted results are always flagged, never suppressed —
 * contradiction is symmetric and neither endpoint is authoritative.
 *
 * ADR #142, item 3: results are then stably partitioned by standing so every
 * `current` row precedes the contested ones (`contradicted` then `superseded`).
 * The incoming vector/BM25/RRF relevance order is preserved within each group —
 * the ordering never re-scores relevance, so hybrid results are not reshuffled.
 */
function applyGraphStanding(
  results: SearchResult[],
  options: SearchServiceOptions,
  d: Database
): SearchResult[] {
  const supersessionMode = options.supersessionMode ?? 'flag'
  const contradictionMode = options.contradictionMode ?? 'flag'
  if (results.length === 0) return results
  if (supersessionMode === 'off' && contradictionMode === 'off') return results

  const standingMap = annotateGraphStanding(d, results.map(r => r.thought.id))
  const annotated: SearchResult[] = []

  for (const result of results) {
    const info = standingMap.get(result.thought.id)
    const supersededBy = supersessionMode === 'off' ? [] : (info?.superseded_by ?? [])
    const contradictedBy = contradictionMode === 'off' ? [] : (info?.contradicted_by ?? [])

    if (supersessionMode === 'suppress' && supersededBy.length > 0) continue

    const next: SearchResult = { ...result, standing: 'current' }
    if (supersededBy.length > 0) {
      next.superseded_by = supersededBy
      next.standing = 'superseded'
    } else if (contradictedBy.length > 0) {
      next.standing = 'contradicted'
    }
    if (contradictedBy.length > 0) next.contradicted_by = contradictedBy
    annotated.push(next)
  }

  return orderByStanding(annotated)
}

/**
 * Deterministic standing-aware ordering (ADR #142, item 3): a stable partition
 * that keeps every `current` row ahead of the contested ones while preserving
 * the incoming (vector/BM25/RRF) relevance order within each standing group.
 *
 * `similarity` is deliberately NOT used as a sort key: it is populated only from
 * the vector leg, so keyword-only results carry `0` and would be demoted
 * below every vector hit, discarding the hybrid fusion ranking.
 *
 * The recency boost is applied *upstream* (inside the DB ranking), so this
 * stable partition preserves the recency order within each standing group.
 *
 * Exported for the ordering regression test only.
 */
export function orderByStanding(results: SearchResult[]): SearchResult[] {
  return [...results].sort(
    (a, b) => STANDING_RANK[a.standing ?? 'current'] - STANDING_RANK[b.standing ?? 'current']
  )
}

export async function searchThoughtsGrouped(
  options: SearchServiceOptions,
  d: Database = getDb()
): Promise<GroupedResult[]> {
  const flat = await searchThoughts(options, d)
  return groupResultsByCluster(flat, d)
}

function filterByTags(results: SearchResult[], tagFilter: string, d: Database): SearchResult[] {
  const tagNames = parseTags(tagFilter)
  if (!tagNames || tagNames.length === 0) return results
  const tagMap = getThoughtTagsBatch(d, results.map(r => r.thought.id))
  return results.filter(r => {
    const tags = tagMap.get(r.thought.id) ?? []
    const thoughtTagNames = new Set(tags.map(t => t.name.toLowerCase()))
    return tagNames.every(n => thoughtTagNames.has(n.toLowerCase()))
  })
}

export function groupResultsByCluster(results: SearchResult[], d: Database = getDb()): GroupedResult[] {
  const clusterMap = new Map<string, SearchResult[]>()
  const nonCluster: SearchResult[] = []

  const clusterByThought = getClusterForThoughtBatch(d, results.map(r => r.thought.id))

  for (const r of results) {
    const cluster = clusterByThought.get(r.thought.id)
    if (cluster) {
      const arr = clusterMap.get(cluster.id) || []
      arr.push(r)
      clusterMap.set(cluster.id, arr)
    } else {
      nonCluster.push(r)
    }
  }

  const grouped: GroupedResult[] = [...nonCluster]

  for (const [clusterId, items] of clusterMap) {
    const clusterThought = getThought(d, clusterId)
    if (clusterThought) {
      grouped.push({
        cluster: { id: clusterThought.id, content: clusterThought.content },
        items
      })
    }
  }

  return grouped
}
