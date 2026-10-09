/**
 * Deterministic propose-only placement engine (ADR 2026-09-28, P5 / §2.2–2.7).
 *
 * Assembles one {@link PlacementPlan} for a single thought from the signal
 * layer (`signals.ts`), the declarative edge-type rules (`edge-type-rules.ts`)
 * and the placement proposer (`placement.ts`). It is strictly read-only: it
 * never mutates the graph and never persists a proposal. Confirmation always
 * happens through the existing write tools.
 *
 * Determinism (ADR §2.7): static ordered rule tables, stable sorts
 * (`confidence` desc, then `target_id` asc) and an injectable `now`. The same
 * database snapshot plus the same `now` yields an identical plan; pairs that
 * already carry any edge are excluded, and proposals are deduplicated by
 * canonical unordered pair key.
 *
 * Degradation (mirrors `edge-detect`): an unavailable embedder sets
 * `degraded: true` and never throws — the plan falls back to lexical-only
 * signals, so a lexical near-duplicate can still yield a `merge` lifecycle
 * while embedding-based edge proposals are suppressed.
 */

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
import { findEmbeddingNeighborPairs, type SearchNeighborsFn } from '../edge-candidates.service'
import { classifyEdgeType } from './edge-type-rules'
import { decideLifecycle, findMergeTarget, keepLifecycle } from './lifecycle'
import { buildCandidatePool, proposePlacement } from './placement'
import { defaultSearchNeighbors } from './search-neighbors'
import { extractPairSignals } from './signals'
import type { EdgeProposal, PlacementPlan, PlacementProposal } from './types'

/** Plan `thought_id` used for an unpersisted draft analysed via `content`. */
export const DRAFT_THOUGHT_ID = '(draft)'

/** Input: an existing thought id, or raw draft content (mutually exclusive). */
export interface PlacementPlanInput {
  /** Existing thought to analyse (takes precedence over `content`). */
  thoughtId?: string
  /** Draft content to analyse when the thought is not persisted yet. */
  content?: string
  /** Project scope for a draft (falls back to `options.projectId`, then default). */
  projectId?: string
}

export interface PlacementPlanOptions {
  /** Clock override for deterministic tests (default `new Date().toISOString()`). */
  now?: string
  /** Project scope; defaults to the thought's own project. */
  projectId?: string
  /** Existing cluster size at or above which the cluster placement is skipped. */
  maxClusterSize?: number
  /** Recall floor for embedding neighbours (default `edgeDetect.minSimilarity`). */
  minSimilarity?: number
  /** Neighbour-search width (default `edgeDetect.topK`). */
  topK?: number
  /** Candidate-pool bound (default `edgeDetect.maxCandidates`). */
  maxCandidates?: number
  /** Cap on emitted edge proposals (default `edgeDetect.maxProposals`). */
  maxProposals?: number
}

/** Injectable dependencies, mirroring `PlacementDeps` for deterministic tests. */
export interface PlacementPlanDeps {
  embed?: (texts: string[]) => Promise<Float32Array[]>
  searchNeighbors?: SearchNeighborsFn
}

type EmbedFn = (texts: string[]) => Promise<Float32Array[]>

/**
 * Resolve the analysed thought: an existing row by id, or a synthetic draft row
 * built from `content`. Throws only on invalid *input* (missing thought, bad
 * arguments) — never on an embedder failure.
 */
function resolveThought(input: PlacementPlanInput, options: PlacementPlanOptions, d: Database, now: string): Thought {
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
      is_profile: 0,
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

/**
 * Single-pass embedding cache. The engine and the placement proposer share the
 * exact same candidate pool, so memoizing by the joined candidate texts keeps
 * one embedder round-trip and one coherent snapshot for both.
 */
function memoizeEmbed(embed: EmbedFn): EmbedFn {
  const cache = new Map<string, Float32Array[]>()
  return async texts => {
    const key = texts.join('\u0000')
    const cached = cache.get(key)
    if (cached) return cached
    const result = await embed(texts)
    cache.set(key, result)
    return result
  }
}

/**
 * Assemble the deterministic, read-only {@link PlacementPlan} for one thought.
 *
 * `input` references an existing thought id or draft content. `options.now`
 * makes the plan clock-free; `deps.embed` / `deps.searchNeighbors` are
 * injectable for deterministic tests. Never throws on an embedder failure —
 * that sets `degraded: true` and falls back to lexical-only signals.
 */
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

  // A cluster thought is an aggregate with no atomic claim: nothing to place
  // or link, and it must never be treated as a merge/link source.
  if (thought.is_cluster) {
    return {
      ...base,
      lifecycle: keepLifecycle('source is a cluster thought; nothing to place or link')
    }
  }

  const projectId = options.projectId ?? thought.project_id
  const maxClusterSize = options.maxClusterSize ?? config.placement.maxClusterSize
  const minSimilarity = options.minSimilarity ?? config.edgeDetect.minSimilarity
  const topK = options.topK ?? config.edgeDetect.topK
  const maxCandidates = options.maxCandidates ?? config.edgeDetect.maxCandidates
  const maxProposals = options.maxProposals ?? config.edgeDetect.maxProposals
  const embed = memoizeEmbed(deps.embed ?? generateEmbeddings)

  const pool = buildCandidatePool(d, thought, projectId, maxCandidates)
  const byId = new Map(pool.map(t => [t.id, t]))
  const mergeTarget = findMergeTarget(pool, thought)

  let degraded = false
  let pairs: ReturnType<typeof findEmbeddingNeighborPairs> = []
  try {
    const embeddings = await embed(pool.map(t => t.content))
    if (embeddings.length !== pool.length) {
      console.error(`[placement] embedder returned ${embeddings.length} vectors for ${pool.length} candidates, degrading`)
      degraded = true
    } else {
      const searchNeighbors = deps.searchNeighbors ?? defaultSearchNeighbors(d, projectId)
      pairs = findEmbeddingNeighborPairs(pool, embeddings, minSimilarity, searchNeighbors, topK)
    }
  } catch (err) {
    console.error('[placement] embedding failed, degrading to lexical-only signals:', err)
    degraded = true
  }

  let placement: PlacementProposal | null = null
  if (!degraded) {
    // Reuse the pairs the shared pass above already produced: the proposer
    // would otherwise rebuild the same pool and repeat the vector search
    // (ADR §2.2 "must not duplicate").
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
    const excluded = getEdgePairKeys(d, pool.map(t => t.id))
    // One batched standing lookup for the source and every candidate, hoisted
    // out of the pair loop (2 queries total instead of 2 per pair).
    const standing = annotateGraphStanding(d, [thought.id, ...pool.map(t => t.id)])
    for (const pair of pairs) {
      const otherId =
        pair.source_id === thought.id ? pair.target_id : pair.target_id === thought.id ? pair.source_id : undefined
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
  // Probe the *uncapped* list so a supersede candidate that sorts past
  // `maxProposals` still wins lifecycle precedence (ADR §2.6).
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
