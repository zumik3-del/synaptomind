import type { Database } from 'bun:sqlite'
import { config } from '../config'
import { getDb } from '../db'
import { getEdgePairKeys } from '../db/edges'
import { searchThoughts } from '../db/search'
import { pairKey } from '../db/utils'
import { generateEmbeddings } from '../embedder/client'
import { findEmbeddingNeighborPairs, type SearchNeighborsFn } from './edge-candidates.service'

/**
 * Contradiction/support candidate detection (ADR #142, D3).
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
 * The recall filter alone cannot tell conflict from agreement, so proposals are
 * emitted as low-confidence `contradicts` candidates with rationale
 * `embedding_similarity_only` and `review_required: true` (similarity ≠
 * conflict).
 */

// ── Proposal / result types ──────────────────────────────────────────────────

interface EdgeProposalSignals {
  embeddingSimilarity: number
}

interface EdgeProposal {
  source_id: string
  target_id: string
  type: 'contradicts' | 'supports'
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

interface DetectionCandidate {
  id: string
  content: string
}

const MAX_CANDIDATES_LIMIT = 1000

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
  const bounded = Math.min(Math.max(Math.floor(limit), 0), MAX_CANDIDATES_LIMIT)
  const base = `
    SELECT t.id, t.content
    FROM thoughts t
    WHERE t.status = 'active'
      AND (t.is_cluster IS NULL OR t.is_cluster = 0)
      AND NOT EXISTS (SELECT 1 FROM edges e WHERE e.type = 'cluster' AND e.target_id = t.id)
  `
  if (projectId) {
    return db
      .prepare(`${base} AND t.project_id = ? ORDER BY t.created_at DESC LIMIT ${bounded}`)
      .all(projectId) as DetectionCandidate[]
  }
  return db
    .prepare(`${base} ORDER BY t.created_at DESC LIMIT ${bounded}`)
    .all() as DetectionCandidate[]
}

// ── Main entry point ─────────────────────────────────────────────────────────

/**
 * Detect contradiction/support candidate pairs. Read-only: no edge is created or
 * modified. Returns an empty result set (never throws) when there are too few
 * candidates or the embedder is unavailable (`degraded: true`).
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
      type: 'contradicts',
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
