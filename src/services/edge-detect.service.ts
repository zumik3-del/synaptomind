import type { Database } from 'bun:sqlite'
import { config } from '../config'
import { getDb } from '../db'
import {
  findDetectionCandidates as dbFindDetectionCandidates,
  type DetectionCandidate
} from '../db/edge-detect'
import { getEdgePairKeys } from '../db/edges'
import { searchThoughts } from '../db/search'
import { pairKey } from '../db/utils'
import { generateEmbeddings } from '../embedder/client'
import { findEmbeddingNeighborPairs, type SearchNeighborsFn } from './edge-candidates.service'

/**
 * Edge candidate detection (ADR #142, D3).
 *
 * This service is a *filter*, never a source of truth: it returns scored
 * proposals for human/agent confirmation and **never writes an edge**. The
 * caller confirms a proposal with `memory_store action=link`.
 *
 * Pipeline:
 *   active non-cluster thoughts (optionally one project)
 *     -> embed content
 *     -> vector neighbour search (recall filter: same subject matter)
 *     -> similarity threshold + existing-edge exclusion
 *     -> EdgeProposal[] (no graph mutation)
 *
 * Decision (task #927, 2026-09-28): proposals are emitted as
 * `type: 'related'`, never `contradicts`. High embedding similarity only means
 * the pair shares subject matter; it is not evidence of mutual exclusivity. The
 * optional NLI precision filter was removed permanently, so this pipeline has
 * no conflict signal at all — labelling similarity-only pairs `contradicts`
 * made a naive consumer read "same subject matter" as "conflict" (prod
 * 2026-09-28 reported 20 phantom contradictions). The honest output is an
 * unconfirmed `related` candidate: `type: 'related'`,
 * `rationale: 'embedding_similarity_only'`, `review_required: true`. Consumers
 * must key on `review_required`/`rationale` and read both thoughts before
 * promoting the pair to a specific type (`contradicts`/`supports`).
 */

// ── Proposal / result types ──────────────────────────────────────────────────

interface EdgeProposalSignals {
  embeddingSimilarity: number
}

interface EdgeProposal {
  source_id: string
  target_id: string
  /**
   * Suggested edge type. Always `related`: the pipeline has no conflict signal,
   * so it must not propose `contradicts`/`supports` (similarity ≠ conflict).
   */
  type: 'related'
  confidence: number
  /** Human-readable provenance: why this pair was proposed. */
  rationale: string
  /**
   * True when the pair rests on embedding similarity alone: high similarity
   * means "same subject matter", NOT "conflict". Consumers must treat such a
   * proposal as an unconfirmed *related* candidate, never as a settled
   * contradiction.
   */
  review_required: boolean
  signals: EdgeProposalSignals
}

interface EdgeDetectOptions {
  projectId?: string
  minSimilarity?: number
  topK?: number
  maxCandidates?: number
  maxProposals?: number
}

interface EdgeDetectResult {
  proposals: EdgeProposal[]
  candidates: number
  pairs_evaluated: number
  /** True when embedding generation failed and detection degraded to no proposals. */
  degraded: boolean
}

/** Injected dependencies for testing (same shape as `AutoLinkDeps`). */
export interface EdgeDetectDeps {
  embed?: (texts: string[]) => Promise<Float32Array[]>
  searchNeighbors?: SearchNeighborsFn
}

// ── Candidate selection ──────────────────────────────────────────────────────

/**
 * Active, non-cluster thoughts that are not cluster members (clusters carry no
 * atomic claim, ADR #142 Decision 2). Optionally scoped to one project to
 * respect project isolation. Bounded so neighbour search stays cheap.
 */
export function findDetectionCandidates(
  db: Database,
  projectId: string | undefined,
  limit: number
): DetectionCandidate[] {
  return dbFindDetectionCandidates(db, projectId, limit)
}

// ── Main entry point ─────────────────────────────────────────────────────────

/**
 * Detect similarity-based `related` candidate pairs. Read-only: no edge is
 * created or modified. Returns an empty result set (never throws) when there
 * are too few candidates or the embedder is unavailable (`degraded: true`).
 * Every proposal is unconfirmed (`review_required: true`); the service never
 * claims conflict.
 */
export async function detectEdgeProposals(
  options: EdgeDetectOptions = {},
  deps: EdgeDetectDeps = {},
  d: Database = getDb()
): Promise<EdgeDetectResult> {
  const minSimilarity = options.minSimilarity ?? config.edgeDetect.minSimilarity
  const topK = options.topK ?? config.edgeDetect.topK
  const maxCandidates = options.maxCandidates ?? config.edgeDetect.maxCandidates
  const maxProposals = options.maxProposals ?? config.edgeDetect.maxProposals
  const embed = deps.embed ?? generateEmbeddings

  const empty = (candidates: number, degraded: boolean): EdgeDetectResult => ({
    proposals: [],
    candidates,
    pairs_evaluated: 0,
    degraded
  })

  const candidates = findDetectionCandidates(d, options.projectId, maxCandidates)
  if (candidates.length < 2) return empty(candidates.length, false)

  let embeddings: Float32Array[]
  try {
    embeddings = await embed(candidates.map(c => c.content))
  } catch (err) {
    console.error('[edge-detect] embedding failed, degrading to no proposals:', err)
    return empty(candidates.length, true)
  }
  if (embeddings.length !== candidates.length) {
    console.error(
      `[edge-detect] embedder returned ${embeddings.length} vectors for ${candidates.length} candidates, degrading`
    )
    return empty(candidates.length, true)
  }

  const searchNeighbors: SearchNeighborsFn =
    deps.searchNeighbors ??
    ((_id, embedding, k) => {
      try {
        return searchThoughts(d, { embedding, topK: k, statusFilter: 'active', hybrid: false }).map(r => ({
          id: r.thought.id,
          similarity: r.similarity
        }))
      } catch (err) {
        console.debug('[edge-detect] neighbour search failed:', err)
        return []
      }
    })

  const pairs = findEmbeddingNeighborPairs(candidates, embeddings, minSimilarity, searchNeighbors, topK)
    .sort((a, b) => b.embeddingSimilarity - a.embeddingSimilarity)

  const excluded = getEdgePairKeys(d, candidates.map(c => c.id))
  const proposals: EdgeProposal[] = []
  let pairsEvaluated = 0

  for (const pair of pairs) {
    if (proposals.length >= maxProposals) break
    if (excluded.has(pairKey(pair.source_id, pair.target_id))) continue
    pairsEvaluated++

    proposals.push({
      source_id: pair.source_id,
      target_id: pair.target_id,
      type: 'related',
      confidence: pair.embeddingSimilarity,
      rationale: 'embedding_similarity_only',
      review_required: true,
      signals: { embeddingSimilarity: pair.embeddingSimilarity }
    })
  }

  return {
    proposals,
    candidates: candidates.length,
    pairs_evaluated: pairsEvaluated,
    degraded: false
  }
}
