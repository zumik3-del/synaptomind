import type { Database } from 'bun:sqlite'
import { config } from '../../config'
import { getDb } from '../../db'
import { getClusterForThoughtBatch, getClusterMembers } from '../../db/cluster-edges'
import { getThoughtEdges } from '../../db/edges'
import { listThoughts, type Thought } from '../../db/thoughts'
import { generateEmbeddings } from '../../embedder/client'
import { clamp01 } from '../../utils'
import { resolveCandidateEmbeddings } from '../candidate-embeddings.service'
import {
  buildInMemoryNeighborLookup,
  findEmbeddingNeighborPairs,
  type SearchNeighborsFn
} from '../edge-candidates.service'
import type { PlacementProposal } from './types'

const HIERARCHY_EDGE_TYPES = new Set(['parent', 'develops'])

export interface PlacementDecision {
  proposal: PlacementProposal | null
  reason: string
}

export interface PlacementOptions {
  projectId?: string
  maxClusterSize?: number
  minSimilarity?: number
  topK?: number
  maxCandidates?: number
  precomputedPairs?: ReturnType<typeof findEmbeddingNeighborPairs>
}

export function resolvePlacementBaseOptions(
  options: PlacementOptions,
  thought: Thought
): {
  projectId: string
  maxClusterSize: number
  minSimilarity: number
  topK: number
  maxCandidates: number
} {
  return {
    projectId: options.projectId ?? thought.project_id,
    maxClusterSize: options.maxClusterSize ?? config.placement.maxClusterSize,
    minSimilarity: options.minSimilarity ?? config.edgeDetect.minSimilarity,
    topK: options.topK ?? config.edgeDetect.topK,
    maxCandidates: options.maxCandidates ?? config.edgeDetect.maxCandidates
  }
}

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

export function buildCandidatePool(
  d: Database,
  thought: Thought,
  projectId: string,
  maxCandidates: number
): Thought[] {
  const pool = listThoughts(d, {
    status: 'active',
    project_id: projectId,
    limit: maxCandidates
  }).filter(t => !t.is_cluster)
  // The source can be a draft the active-only query skips; pair generation needs it present.
  if (!pool.some(t => t.id === thought.id)) pool.unshift(thought)
  return pool
}

function neighborsOf(
  thoughtId: string,
  pairs: ReturnType<typeof findEmbeddingNeighborPairs>
): ScoredNeighbor[] {
  const byId = new Map<string, number>()
  for (const pair of pairs) {
    const other =
      pair.source_id === thoughtId
        ? pair.target_id
        : pair.target_id === thoughtId
          ? pair.source_id
          : undefined
    if (other === undefined) continue
    const previous = byId.get(other)
    if (previous === undefined || pair.embeddingSimilarity > previous)
      byId.set(other, pair.embeddingSimilarity)
  }
  return [...byId.entries()]
    .map(([id, similarity]) => ({ id, similarity }))
    .sort((a, b) => b.similarity - a.similarity || a.id.localeCompare(b.id))
}

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
    reasons.push(
      `no cluster majority (best ${best.count}/${clusteredTotal} in cluster ${best.clusterId})`
    )
    return null
  }

  const memberCount = getClusterMembers(d, best.clusterId).length
  if (memberCount >= maxClusterSize) {
    reasons.push(
      `cluster ${best.clusterId} has ${memberCount} members >= maxClusterSize ${maxClusterSize}`
    )
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

function proposeParent(
  d: Database,
  neighbors: ScoredNeighbor[],
  reasons: string[]
): PlacementProposal | null {
  for (const neighbor of neighbors) {
    const edges = getThoughtEdges(d, neighbor.id, 'both')
    if (!edges) continue
    const inChain = [...edges.upstream, ...edges.downstream].some(e =>
      HIERARCHY_EDGE_TYPES.has(e.edge.type)
    )
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

function observeEmbed(embed: (texts: string[]) => Promise<Float32Array[]>): {
  embed: (texts: string[]) => Promise<Float32Array[]>
  countMismatch: () => boolean
} {
  let expected = 0
  let produced = 0
  let returned = false
  return {
    embed: async texts => {
      expected = texts.length
      const vectors = await embed(texts)
      produced = vectors.length
      returned = true
      return vectors
    },
    countMismatch: () => returned && produced !== expected
  }
}

export async function proposePlacement(
  thought: Thought,
  options: PlacementOptions = {},
  deps: PlacementDeps = {},
  d: Database = getDb()
): Promise<PlacementDecision> {
  const { projectId, maxClusterSize, minSimilarity, topK, maxCandidates } =
    resolvePlacementBaseOptions(options, thought)

  if (thought.is_cluster) return noPlacement('source is a cluster thought')

  let pairs: ReturnType<typeof findEmbeddingNeighborPairs>

  if (options.precomputedPairs) {
    pairs = options.precomputedPairs
  } else {
    const pool = buildCandidatePool(d, thought, projectId, maxCandidates)
    const observed = observeEmbed(deps.embed ?? generateEmbeddings)

    let embeddings: Float32Array[]
    try {
      embeddings = await resolveCandidateEmbeddings(pool, observed.embed, d)
    } catch (err) {
      console.error('[placement] embedding failed, no placement proposed:', err)
      return noPlacement(
        observed.countMismatch()
          ? 'embedder returned a mismatched number of vectors'
          : 'embedder unavailable'
      )
    }

    const searchNeighbors: SearchNeighborsFn =
      deps.searchNeighbors ?? buildInMemoryNeighborLookup(pool, embeddings)

    pairs = findEmbeddingNeighborPairs(pool, embeddings, minSimilarity, searchNeighbors, topK)
  }

  const neighbors = neighborsOf(thought.id, pairs)
  if (neighbors.length === 0)
    return noPlacement('no embedding neighbours above the similarity threshold')

  const reasons: string[] = []
  const cluster = proposeCluster(d, neighbors, projectId, maxClusterSize, reasons)
  if (cluster) return { proposal: cluster, reason: cluster.rationale }

  const parent = proposeParent(d, neighbors, reasons)
  if (parent) return { proposal: parent, reason: parent.rationale }

  return noPlacement(reasons.join('; '))
}
