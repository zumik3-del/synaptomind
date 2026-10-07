/**
 * Read-only placement proposer (ADR 2026-09-28, P4 / §2.2).
 *
 * For one thought it decides *where the thought belongs*: an existing cluster
 * (a majority of its embedding neighbours already live in one cluster) or under
 * a parent (`parent`/`develops`) chain node, or nothing. It only ever
 * *proposes*: it reuses the shared embedding-pair generator
 * ({@link findEmbeddingNeighborPairs}) and existing db read helpers, and never
 * calls an edge/cluster/lifecycle writer (ADR §2.4).
 *
 * Reuse (ADR §2.2, "must not duplicate"):
 *   - pair generation → `edge-candidates.service.ts`
 *   - embedding ranking → `searchThoughts`
 *   - cluster membership → `getClusterForThoughtBatch` / `getClusterMembers`
 *   - hierarchy lookup  → `getThoughtEdges`
 *
 * Project scope is enforced structurally: the candidate pool is loaded for one
 * project, and `findEmbeddingNeighborPairs` keeps only neighbours that are in
 * that pool, so cross-project neighbours can never enter a proposal.
 */

import type { Database } from 'bun:sqlite'
import { config } from '../../config'
import { getDb } from '../../db'
import { getClusterForThoughtBatch, getClusterMembers, getThoughtEdges } from '../../db/edges'
import { listThoughts, type Thought } from '../../db/thoughts'
import { generateEmbeddings } from '../../embedder/client'
import { clamp01 } from '../../utils'
import { findEmbeddingNeighborPairs, type SearchNeighborsFn } from '../edge-candidates.service'
import { defaultSearchNeighbors } from './search-neighbors'
import type { PlacementProposal } from './types'

/** Directed hierarchy edge types that make a thought a chain node. */
const HIERARCHY_EDGE_TYPES = new Set(['parent', 'develops'])

/**
 * The outcome of {@link proposePlacement}: a proposal, or `null` when nothing
 * applies. `reason` is always present and explains the decision (why this
 * target, or why every branch was skipped).
 */
export interface PlacementDecision {
  proposal: PlacementProposal | null
  reason: string
}

export interface PlacementOptions {
  /** Project scope; defaults to the thought's own project. */
  projectId?: string
  /** Existing cluster size at or above which the cluster is skipped. */
  maxClusterSize?: number
  /** Recall floor for embedding neighbours (default `edgeDetect.minSimilarity`). */
  minSimilarity?: number
  /** Neighbour-search width (default `edgeDetect.topK`). */
  topK?: number
  /** Candidate-pool bound (default `edgeDetect.maxCandidates`). */
  maxCandidates?: number
  /**
   * Precomputed embedding-neighbour pairs for this thought, produced by the
   * shared pool the caller already built. When set, {@link proposePlacement}
   * skips the candidate-pool build, the embedder round-trip and the vector
   * search and derives its neighbours from these pairs directly. This is the
   * seam that lets the engine reuse its single embedding pass instead of
   * repeating it (ADR §2.2 "must not duplicate"); the pairs are identical to
   * what this function would compute, so determinism is unchanged.
   */
  precomputedPairs?: ReturnType<typeof findEmbeddingNeighborPairs>
}

/** Injectable dependencies, mirroring `EdgeDetectDeps` for deterministic tests. */
export interface PlacementDeps {
  embed?: (texts: string[]) => Promise<Float32Array[]>
  searchNeighbors?: SearchNeighborsFn
}

interface ScoredNeighbor {
  id: string
  similarity: number
}

function noPlacement(reason: string): PlacementDecision {
  return { proposal: null, reason }
}

/**
 * Active, non-cluster thoughts of one project, bounded so neighbour search
 * stays cheap. The source thought is always present (it may be a draft that is
 * not returned by the active-only query) so that pair generation can surface
 * its neighbours.
 *
 * Exported so the placement engine can embed the exact same pool (one shared
 * embedding pass) instead of duplicating the candidate-selection logic.
 */
export function buildCandidatePool(d: Database, thought: Thought, projectId: string, maxCandidates: number): Thought[] {
  const pool = listThoughts(d, { status: 'active', project_id: projectId, limit: maxCandidates }).filter(
    t => !t.is_cluster
  )
  if (!pool.some(t => t.id === thought.id)) pool.unshift(thought)
  return pool
}

/** The source's neighbours from the shared pair generator, best similarity first. */
function neighborsOf(thoughtId: string, pairs: ReturnType<typeof findEmbeddingNeighborPairs>): ScoredNeighbor[] {
  const byId = new Map<string, number>()
  for (const pair of pairs) {
    const other =
      pair.source_id === thoughtId ? pair.target_id : pair.target_id === thoughtId ? pair.source_id : undefined
    if (other === undefined) continue
    const previous = byId.get(other)
    if (previous === undefined || pair.embeddingSimilarity > previous) byId.set(other, pair.embeddingSimilarity)
  }
  return [...byId.entries()]
    .map(([id, similarity]) => ({ id, similarity }))
    .sort((a, b) => b.similarity - a.similarity || a.id.localeCompare(b.id))
}

/**
 * Propose the cluster that the majority of the source's clustered neighbours
 * belong to. Returns `null` and appends to `reasons` when there is no
 * clustered neighbour, no strict majority, or the majority cluster is at/over
 * the size cap (lessons #934/#928).
 */
function proposeCluster(
  d: Database,
  neighbors: ScoredNeighbor[],
  projectId: string,
  maxClusterSize: number,
  reasons: string[]
): PlacementProposal | null {
  const clusterMap = getClusterForThoughtBatch(
    d,
    neighbors.map(n => n.id)
  )
  const counts = new Map<string, { clusterId: string; count: number; similaritySum: number }>()
  for (const neighbor of neighbors) {
    const cluster = clusterMap.get(neighbor.id)
    // Cross-project clusters are ignored even if an edge crossed projects.
    if (!cluster || cluster.project_id !== projectId) continue
    const entry = counts.get(cluster.id) ?? { clusterId: cluster.id, count: 0, similaritySum: 0 }
    entry.count += 1
    entry.similaritySum += neighbor.similarity
    counts.set(cluster.id, entry)
  }

  if (counts.size === 0) {
    reasons.push('no neighbour belongs to a cluster')
    return null
  }

  const clustered = [...counts.values()].sort(
    (a, b) => b.count - a.count || a.clusterId.localeCompare(b.clusterId)
  )
  const clusteredTotal = clustered.reduce((sum, entry) => sum + entry.count, 0)
  const best = clustered[0]
  if (best.count * 2 <= clusteredTotal) {
    reasons.push(`no cluster majority (best ${best.count}/${clusteredTotal} in cluster ${best.clusterId})`)
    return null
  }

  const memberCount = getClusterMembers(d, best.clusterId).length
  if (memberCount >= maxClusterSize) {
    reasons.push(`cluster ${best.clusterId} has ${memberCount} members >= maxClusterSize ${maxClusterSize}`)
    return null
  }

  const share = best.count / clusteredTotal
  const averageSimilarity = best.similaritySum / best.count
  return {
    kind: 'cluster',
    target_id: best.clusterId,
    confidence: clamp01(0.5 * share + 0.5 * averageSimilarity),
    rationale: `cluster majority: ${best.count}/${clusteredTotal} clustered embedding neighbours belong to cluster ${best.clusterId} (avg similarity ${averageSimilarity.toFixed(2)})`,
    review_required: true
  }
}

/**
 * Propose attaching the source under the nearest embedding neighbour that
 * already participates in a `parent`/`develops` chain (`getThoughtEdges`).
 * Returns `null` and appends to `reasons` when no neighbour is a chain node.
 */
function proposeParent(d: Database, neighbors: ScoredNeighbor[], reasons: string[]): PlacementProposal | null {
  for (const neighbor of neighbors) {
    const edges = getThoughtEdges(d, neighbor.id, 'both')
    if (!edges) continue
    const inChain = [...edges.upstream, ...edges.downstream].some(e => HIERARCHY_EDGE_TYPES.has(e.edge.type))
    if (!inChain) continue
    return {
      kind: 'parent',
      target_id: neighbor.id,
      confidence: clamp01(neighbor.similarity),
      rationale: `nearest neighbour ${neighbor.id} participates in a parent/develops chain (similarity ${neighbor.similarity.toFixed(2)})`,
      review_required: true
    }
  }
  reasons.push('no parent/develops chain node among the embedding neighbours')
  return null
}

/**
 * Propose where one thought belongs, or `null` with a reason. Read-only: the
 * result is an advisory {@link PlacementProposal} (cluster then parent
 * precedence) and no edge/cluster/lifecycle mutation is performed. Never
 * throws: a missing embedder degrades to "no placement".
 */
export async function proposePlacement(
  thought: Thought,
  options: PlacementOptions = {},
  deps: PlacementDeps = {},
  d: Database = getDb()
): Promise<PlacementDecision> {
  const projectId = options.projectId ?? thought.project_id
  const maxClusterSize = options.maxClusterSize ?? config.placement.maxClusterSize
  const minSimilarity = options.minSimilarity ?? config.edgeDetect.minSimilarity
  const topK = options.topK ?? config.edgeDetect.topK
  const maxCandidates = options.maxCandidates ?? config.edgeDetect.maxCandidates

  if (thought.is_cluster) return noPlacement('source is a cluster thought')

  let pairs: ReturnType<typeof findEmbeddingNeighborPairs>

  if (options.precomputedPairs) {
    // The caller already built the pool and ran the single shared embedding
    // pass; reuse its pairs instead of repeating the vector search.
    pairs = options.precomputedPairs
  } else {
    const pool = buildCandidatePool(d, thought, projectId, maxCandidates)
    const embed = deps.embed ?? generateEmbeddings

    let embeddings: Float32Array[]
    try {
      embeddings = await embed(pool.map(t => t.content))
    } catch (err) {
      console.error('[placement] embedding failed, no placement proposed:', err)
      return noPlacement('embedder unavailable')
    }
    if (embeddings.length !== pool.length) {
      console.error(`[placement] embedder returned ${embeddings.length} vectors for ${pool.length} candidates`)
      return noPlacement('embedder returned a mismatched number of vectors')
    }

    const searchNeighbors: SearchNeighborsFn = deps.searchNeighbors ?? defaultSearchNeighbors(d, projectId)

    pairs = findEmbeddingNeighborPairs(pool, embeddings, minSimilarity, searchNeighbors, topK)
  }

  const neighbors = neighborsOf(thought.id, pairs)
  if (neighbors.length === 0) return noPlacement('no embedding neighbours above the similarity threshold')

  const reasons: string[] = []
  const cluster = proposeCluster(d, neighbors, projectId, maxClusterSize, reasons)
  if (cluster) return { proposal: cluster, reason: cluster.rationale }

  const parent = proposeParent(d, neighbors, reasons)
  if (parent) return { proposal: parent, reason: parent.rationale }

  return noPlacement(reasons.join('; '))
}
