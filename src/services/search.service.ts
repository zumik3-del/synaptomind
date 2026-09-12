import { getClusterForThoughtBatch } from '../db/edges'
import { getDb } from '../db'
import { annotateGraphStanding, type GraphStanding } from '../db/graph-annotations'
import { type SearchResult, searchThoughts as dbSearchThoughts } from '../db/search'
import { getThoughtTagsBatch } from '../db/tags'
import { getThought, parseTags } from '../db/thoughts'
import type { Database } from 'bun:sqlite'
import { generateEmbedding } from '../embedder/client'
import { entitySearchIds } from './entity.service'

const EMBEDDING_TIMEOUT_MS = 5_000
const SEARCH_MAX_TOP_K = 1000
/**
 * Candidate-pool multiplier used when `supersessionMode === 'suppress'`: rows are
 * dropped after the DB fetch, so the pool must be widened to still return `topK`
 * surviving results. The widened pool is capped at `SEARCH_MAX_TOP_K`.
 */
const SUPPRESSION_OVERFETCH_FACTOR = 4

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

function clampTopK(value: number | undefined): number {
  if (value === undefined || !Number.isFinite(value)) return 10
  return Math.min(Math.max(Math.floor(value), 1), SEARCH_MAX_TOP_K)
}

function clampMinImportance(value: number | undefined): number | undefined {
  if (value === undefined || !Number.isFinite(value)) return undefined
  return Math.min(Math.max(value, 0), 1)
}

async function generateEmbeddingWithFallback(query: string): Promise<Float32Array> {
  try {
    return await Promise.race([
      generateEmbedding(query),
      new Promise<never>((_, reject) =>
        setTimeout(() => reject(new Error('Embedding timeout')), EMBEDDING_TIMEOUT_MS)
      )
    ])
  } catch (err) {
    console.error('[search] embedding generation failed, falling back to BM25:', err instanceof Error ? err.message : err)
    return new Float32Array(0)
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
  excludeFlagged?: boolean
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
}

export interface GroupedResult {
  thought?: SearchResult['thought']
  cluster?: { id: string; content: string }
  items?: SearchResult[]
}

export async function searchThoughts(options: SearchServiceOptions): Promise<SearchResult[]> {
  const d = getDb()
  const topK = clampTopK(options.topK)
  const minImportance = clampMinImportance(options.minImportance)
  const supersessionMode = options.supersessionMode ?? 'flag'
  // Suppression drops rows after the DB fetch, so widen the candidate pool to
  // backfill the survivors up to `topK` (bounded by SEARCH_MAX_TOP_K).
  const candidateK =
    supersessionMode === 'suppress'
      ? Math.min(SEARCH_MAX_TOP_K, topK * SUPPRESSION_OVERFETCH_FACTOR)
      : topK
  const embedding = options.embedding ?? (await generateEmbeddingWithFallback(options.query))
  const results = dbSearchThoughts(d, {
    embedding,
    query: options.query,
    topK: candidateK,
    statusFilter: options.statusFilter,
    projectFilter: options.projectFilter,
    clusterFilter: options.clusterFilter,
    minImportance,
    excludeFlagged: options.excludeFlagged,
    hybrid: options.hybrid,
    entitySearchIds
  })

  const filtered = options.tagFilter
    ? filterByTags(results, options.tagFilter, d)
    : results
  const standing = applyGraphStanding(filtered, options, d)
  return standing.length > topK ? standing.slice(0, topK) : standing
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
 * the vector leg, so keyword/entity-only results carry `0` and would be demoted
 * below every vector hit, discarding the hybrid fusion ranking.
 *
 * Exported for the ordering regression test only.
 */
export function orderByStanding(results: SearchResult[]): SearchResult[] {
  return [...results].sort(
    (a, b) => STANDING_RANK[a.standing ?? 'current'] - STANDING_RANK[b.standing ?? 'current']
  )
}

export async function searchThoughtsGrouped(options: SearchServiceOptions): Promise<GroupedResult[]> {
  const flat = await searchThoughts(options)
  return groupResultsByCluster(flat)
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

export function groupResultsByCluster(results: SearchResult[]): GroupedResult[] {
  const d = getDb()
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
