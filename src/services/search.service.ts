import { getClusterForThoughtBatch } from '../db/cluster-edges'
import { getDb } from '../db'
import { type SearchResult, searchThoughts as dbSearchThoughts } from '../db/search'
export type { SearchResult } from '../db/search'
import { getThoughtTagsBatch } from '../db/tags'
import { getThought } from '../db/thoughts'
import type { Database } from 'bun:sqlite'
import { generateEmbedding } from '../embedder/client'
import { parseTags } from '../utils'
import { type IdLookup, idNotFoundWarning, keepsUnderRelevanceGate, runIdLookup, type SearchOutcome } from './search-outcome'
import { normalizeSearchOptions, type NormalizedSearchOptions } from './search-normalize'
import { applyGraphStanding } from './search-standing'
import { calibrateRelevance } from './text-similarity'

export type { SearchOutcome, SearchOutcomeReason } from './search-outcome'

const EMBEDDING_TIMEOUT_MS = 5_000

async function generateEmbeddingWithFallback(query: string): Promise<{ embedding: Float32Array; degraded: boolean }> {
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    const embedding = await Promise.race([
      generateEmbedding(query),
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error('Embedding timeout')), EMBEDDING_TIMEOUT_MS)
      })
    ])
    return { embedding, degraded: false }
  } catch (err) {
    console.error('[search] embedding generation failed, falling back to BM25:', err instanceof Error ? err.message : err)
    return { embedding: new Float32Array(0), degraded: true }
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
   * Relevance gate on the calibrated `relevance` scale, clamped to `[0, 1]`.
   * Omitted → the measured default (`DEFAULT_MIN_RELEVANCE` in
   * `search-normalize.ts`): a row without a lexical (BM25) anchor is kept only
   * when its calibrated `relevance` clears the threshold. An explicit `0`
   * disables the gate and keeps the pre-#2178 result set byte-identically (same
   * rows, same order). The candidate pool is widened when the gate can drop rows
   * so `topK` survivors are still reachable.
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

/**
 * Internal search run: the outcome plus the collection-level degradation flag.
 */
interface SearchRun extends SearchOutcome {
  degraded: boolean
}

async function runSearch(options: SearchServiceOptions, d: Database): Promise<SearchRun> {
  const normalized = normalizeSearchOptions(options)
  // An id-shaped query is an explicit reference: resolve it directly, before the
  // embedding/BM25 legs and the scope filters. A *miss* is not an answer though —
  // an id-shaped word must never zero out a legitimate search — so it falls
  // through to the normal search and only leaves a warning behind. A prefix is
  // not a reference: it is a timestamp window, so it inherits the caller's
  // status/project scope (a full UUID does not).
  const idLookup = runIdLookup(options.query, d, normalized.topK, {
    statusFilter: options.statusFilter,
    projectFilter: options.projectFilter,
    clusterFilter: options.clusterFilter
  })
  if (idLookup && idLookup.items.length > 0) {
    return resolveIdLookup(idLookup, options, normalized, d)
  }
  const idWarnings = idLookup ? [idNotFoundWarning(options.query)] : []

  const {
    topK,
    minImportance,
    minRelevance,
    confidenceFloor,
    unrelatedFloor,
    candidateK,
    recencyWeight,
    recencyHalfLifeDays
  } = normalized
  const embeddingResult = options.embedding
    ? { embedding: options.embedding, degraded: false }
    : await generateEmbeddingWithFallback(options.query)
  const embedding = embeddingResult.embedding
  const embeddingDegraded = embeddingResult.degraded
  const dbResults = dbSearchThoughts(d, {
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
  const dbDegraded = (dbResults as { degraded?: boolean }).degraded === true

  // Calibrate the cosine leg onto the measured unrelated→strong-match band. Only
  // embedding-leg hits carry a cosine scale; a BM25-only hit keeps `relevance`
  // undefined so a keyword match is never read as a weak semantic one.
  for (const result of dbResults) {
    if (result.similarity !== undefined) {
      result.relevance = calibrateRelevance(result.similarity, unrelatedFloor, confidenceFloor)
    }
  }

  const filtered = options.tagFilter
    ? filterByTags(dbResults, options.tagFilter, d)
    : dbResults
  const standing = applyGraphStanding(filtered, options, d)
  // Gate after standing annotation (a suppressed row is already gone) and
  // before the final `topK` slice; the DB-slice overfetch above backfills it.
  const gated = standing.filter(r => keepsUnderRelevanceGate(r, minRelevance))
  const finalResults = gated.length > topK ? gated.slice(0, topK) : gated
  const degraded = embeddingDegraded || dbDegraded
  // Single annotation layer (service): fold the embedding leg's state into the
  // DB leg's degraded flag on each result. The former `signals` triple is
  // collapsed into this one boolean, mirroring the placement engine.
  for (const r of finalResults) {
    r.degraded = degraded
  }
  const outcome: SearchRun = {
    items: finalResults,
    matched: standing.length,
    filtered_out: standing.length - gated.length,
    degraded
  }
  if (idWarnings.length > 0) {
    outcome.warnings = idWarnings
    // With nothing to fall back to, "id_not_found" is the more precise answer
    // than a bare "no_match"; rows the fallback did return keep `no_match`
    // semantics and carry only the warning.
    if (standing.length === 0) outcome.reason = 'id_not_found'
  }
  return outcome
}

/**
 * Answer an id-shaped query that addressed at least one thought.
 *
 * Standing is annotated exactly as for any other hit, but never suppressed: a
 * caller who named an id must get that thought back even when it is superseded
 * (the agent-facing default is `suppress`), so a suppressed request degrades to
 * `flag` here. A contested row is not re-flagged `low_confidence` though: that
 * field means "weak retrieval" (no BM25 anchor, cosine below the vector floor),
 * and an id hit has no cosine at all — `standing`/`superseded_by`/
 * `contradicted_by` already carry the contested state, and a client that drops
 * low-confidence rows would otherwise discard the exact row it asked for. The
 * relevance gate never sees these rows (an id is not a similarity match).
 */
function resolveIdLookup(
  lookup: IdLookup,
  options: SearchServiceOptions,
  normalized: NormalizedSearchOptions,
  d: Database
): SearchRun {
  const annotated = applyGraphStanding(
    lookup.items,
    {
      supersessionMode: options.supersessionMode === 'suppress' ? 'flag' : options.supersessionMode,
      contradictionMode: options.contradictionMode
    },
    d
  )
  const items = annotated.length > normalized.topK ? annotated.slice(0, normalized.topK) : annotated
  return {
    items,
    matched: items.length,
    filtered_out: 0,
    degraded: false,
    ...(lookup.ambiguous ? { ambiguous: true } : {})
  }
}

export async function searchThoughts(options: SearchServiceOptions, d: Database = getDb()): Promise<SearchResult[]> {
  const { items, degraded } = await runSearch(options, d)
  // Preserve a top-level degraded flag for empty result sets (consumed by
  // getContextService and other in-process callers; not an array own-property
  // on the wire).
  Object.assign(items, { degraded })
  return items
}

/**
 * Source-compatible sibling of {@link searchThoughts}: same rows and order,
 * plus the machine-readable match bookkeeping (`matched`, `filtered_out`,
 * `reason`, `ambiguous`, `warnings`). The MCP envelope consumes this; the
 * array-returning service stays the surface for HTTP, context and clusters.
 */
export async function searchThoughtsOutcome(
  options: SearchServiceOptions,
  d: Database = getDb()
): Promise<SearchOutcome> {
  const { items, degraded, ...outcome } = await runSearch(options, d)
  Object.assign(items, { degraded })
  return { ...outcome, items }
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
