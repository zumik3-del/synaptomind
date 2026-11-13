import type { Database } from 'bun:sqlite'
import { config } from '../../config'
import { getDb } from '../../db'
import { getEdgePairKeys } from '../../db/edges'
import { annotateGraphStanding } from '../../db/graph-annotations'
import { resolveDefaultProjectId } from '../../db/projects'
import { getThoughtRow, type Thought } from '../../db/thoughts'
import { pairKey } from '../../db/utils'
import { generateEmbeddings } from '../../embedder/client'
import { NotFoundError, ValidationError } from '../../errors'
import { resolveCandidateEmbeddings } from '../candidate-embeddings.service'
import {
  buildInMemoryNeighborLookup,
  findEmbeddingNeighborPairs,
  type SearchNeighborsFn
} from '../edge-candidates.service'
import { classifyEdgeType } from './edge-type-rules'
import { decideLifecycle, findMergeTarget, keepLifecycle } from './lifecycle'
import { buildCandidatePool, proposePlacement, resolvePlacementBaseOptions } from './placement'
import { extractPairSignals } from './signals'
import type { EdgeProposal, PlacementPlan, PlacementProposal } from './types'

export const DRAFT_THOUGHT_ID = '(draft)'

export interface PlacementPlanInput {
  thoughtId?: string
  content?: string
  projectId?: string
}

export interface PlacementPlanOptions {
  now?: string
  projectId?: string
  maxClusterSize?: number
  minSimilarity?: number
  topK?: number
  maxCandidates?: number
  maxProposals?: number
}

export interface PlacementPlanDeps {
  embed?: (texts: string[]) => Promise<Float32Array[]>
  searchNeighbors?: SearchNeighborsFn
}

function resolveThought(
  input: PlacementPlanInput,
  options: PlacementPlanOptions,
  d: Database,
  now: string
): Thought {
  if (input.thoughtId !== undefined) {
    const thought = getThoughtRow(d, input.thoughtId)
    if (!thought) throw new NotFoundError(`Thought '${input.thoughtId}' not found`)
    return thought
  }
  if (input.content !== undefined) {
    const projectId = input.projectId ?? options.projectId ?? resolveDefaultProjectId(d)
    return {
      id: DRAFT_THOUGHT_ID,
      content: input.content,
      status: 'draft',
      tags: [],
      source: null,
      project_id: projectId,
      is_cluster: 0,
      is_protected: 0,
      is_global: 0,
      created_at: now,
      updated_at: now,
      archived_at: null,
      surface_after: null
    }
  }
  throw new ValidationError('provide either thoughtId (existing thought) or content (draft)')
}

export async function proposePlacementPlan(
  input: PlacementPlanInput,
  options: PlacementPlanOptions = {},
  deps: PlacementPlanDeps = {},
  d: Database = getDb()
): Promise<PlacementPlan> {
  const now = options.now ?? new Date().toISOString()
  const thought = resolveThought(input, options, d, now)
  const base = {
    thought_id: thought.id,
    placement: null as PlacementProposal | null,
    edges: [] as EdgeProposal[],
    lifecycle: keepLifecycle('no proposal'),
    degraded: false,
    generated_at: now
  }

  if (thought.is_cluster) {
    return {
      ...base,
      lifecycle: keepLifecycle('source is a cluster thought; nothing to place or link')
    }
  }

  const { projectId, maxClusterSize, minSimilarity, topK, maxCandidates } =
    resolvePlacementBaseOptions(options, thought)
  const maxProposals = options.maxProposals ?? config.edgeDetect.maxProposals
  const embed = deps.embed ?? generateEmbeddings

  const pool = buildCandidatePool(d, thought, projectId, maxCandidates)
  const byId = new Map(pool.map(t => [t.id, t]))
  const mergeTarget = findMergeTarget(pool, thought)

  let degraded = false
  let pairs: ReturnType<typeof findEmbeddingNeighborPairs> = []
  try {
    const embeddings = await resolveCandidateEmbeddings(pool, embed, d)
    const searchNeighbors = deps.searchNeighbors ?? buildInMemoryNeighborLookup(pool, embeddings)
    pairs = findEmbeddingNeighborPairs(pool, embeddings, minSimilarity, searchNeighbors, topK)
  } catch (err) {
    console.error('[placement] embedding failed, degrading to lexical-only signals:', err)
    degraded = true
  }

  let placement: PlacementProposal | null = null
  if (!degraded) {
    const decision = await proposePlacement(
      thought,
      { projectId, maxClusterSize, minSimilarity, topK, maxCandidates, precomputedPairs: pairs },
      { ...deps, embed },
      d
    )
    placement = decision.proposal
  }

  const edges: EdgeProposal[] = []
  if (!degraded) {
    const excluded = getEdgePairKeys(
      d,
      pool.map(t => t.id)
    )
    const standing = annotateGraphStanding(d, [thought.id, ...pool.map(t => t.id)])
    for (const pair of pairs) {
      const otherId =
        pair.source_id === thought.id
          ? pair.target_id
          : pair.target_id === thought.id
            ? pair.source_id
            : undefined
      if (otherId === undefined) continue
      const key = pairKey(thought.id, otherId)
      if (excluded.has(key)) continue
      const other = byId.get(otherId)
      if (!other) continue
      const signals = extractPairSignals(
        thought,
        other,
        { now, embeddingSimilarity: pair.embeddingSimilarity },
        { standing },
        d
      )
      const proposal = classifyEdgeType(signals)
      if (proposal) edges.push(proposal)
    }
  }

  edges.sort((a, b) => b.confidence - a.confidence || a.target_id.localeCompare(b.target_id))
  const cappedEdges = edges.slice(0, maxProposals)
  const replaceEdge = edges.find(
    e => e.rule_id === 'supersede.newer_replaces_older' && e.signals.targetStatus === 'active'
  )

  return {
    ...base,
    placement,
    edges: cappedEdges,
    lifecycle: decideLifecycle(thought, replaceEdge, cappedEdges, mergeTarget, degraded),
    degraded
  }
}
