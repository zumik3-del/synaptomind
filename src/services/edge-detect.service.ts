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
 *     -> optional NLI port (precision filter)
 *     -> EdgeProposal[] (no graph mutation)
 *
 * Without an NLI classifier the recall filter alone cannot tell conflict from
 * agreement, so proposals are emitted as low-confidence `contradicts`
 * candidates with rationale `embedding_similarity_only`. An NLI classifier,
 * when injected, gates proposals on `nliThreshold` (contradiction) or
 * `supportThreshold` (entailment) and can label `supports` too.
 */

// ── NLI port (injected, default off) ─────────────────────────────────────────

export interface NliVerdict {
  entailment: number
  contradiction: number
  neutral: number
}

export interface NliClassifier {
  classify(premise: string, hypothesis: string): Promise<NliVerdict>
}

// ── Proposal / result types ──────────────────────────────────────────────────

export interface EdgeProposalSignals {
  embeddingSimilarity: number
  nliScore?: number
}

export interface EdgeProposal {
  source_id: string
  target_id: string
  type: 'contradicts' | 'supports'
  confidence: number
  /** Human-readable provenance: why this pair was proposed. */
  rationale: string
  signals: EdgeProposalSignals
}

export interface EdgeDetectOptions {
  projectId?: string
  minSimilarity?: number
  topK?: number
  maxCandidates?: number
  maxProposals?: number
  nliThreshold?: number
  supportThreshold?: number
}

export interface EdgeDetectResult {
  proposals: EdgeProposal[]
  candidates: number
  pairs_evaluated: number
  /** True when embedding generation failed and detection degraded to no proposals. */
  degraded: boolean
  nli_enabled: boolean
}

/** Injected dependencies for testing (same shape as `AutoLinkDeps`). */
export interface EdgeDetectDeps {
  embed?: (texts: string[]) => Promise<Float32Array[]>
  searchNeighbors?: SearchNeighborsFn
  nli?: NliClassifier | null
}

// ── Candidate selection ──────────────────────────────────────────────────────

export interface DetectionCandidate {
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

// ── NLI pair classification ──────────────────────────────────────────────────

interface NliThresholds {
  contradictThreshold: number
  supportThreshold: number
}

/**
 * Classify one pair in both directions. Contradiction is symmetric
 * (`max(contradiction)`); `supports` is directed, so the higher-entailment
 * direction wins. Contradiction takes precedence over support.
 */
async function classifyPair(
  nli: NliClassifier,
  pair: { source_id: string; target_id: string; embeddingSimilarity: number },
  contentById: Map<string, string>,
  thresholds: NliThresholds
): Promise<EdgeProposal | null> {
  const a = contentById.get(pair.source_id)
  const b = contentById.get(pair.target_id)
  if (a === undefined || b === undefined) return null

  const [forward, reverse] = await Promise.all([nli.classify(a, b), nli.classify(b, a)])

  const contradiction = Math.max(forward.contradiction, reverse.contradiction)
  if (contradiction >= thresholds.contradictThreshold) {
    return {
      source_id: pair.source_id,
      target_id: pair.target_id,
      type: 'contradicts',
      confidence: contradiction,
      rationale: 'nli_contradiction',
      signals: { embeddingSimilarity: pair.embeddingSimilarity, nliScore: contradiction }
    }
  }

  const forwardEntailment = forward.entailment
  const reverseEntailment = reverse.entailment
  const best = Math.max(forwardEntailment, reverseEntailment)
  if (best >= thresholds.supportThreshold) {
    const forwardWins = forwardEntailment >= reverseEntailment
    return {
      source_id: forwardWins ? pair.source_id : pair.target_id,
      target_id: forwardWins ? pair.target_id : pair.source_id,
      type: 'supports',
      confidence: best,
      rationale: 'nli_entailment',
      signals: { embeddingSimilarity: pair.embeddingSimilarity, nliScore: best }
    }
  }

  return null
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
  const contradictThreshold = options.nliThreshold ?? config.edgeDetect.nliThreshold
  const supportThreshold = options.supportThreshold ?? config.edgeDetect.supportThreshold
  const embed = deps.embed ?? generateEmbeddings
  const nli = deps.nli ?? null
  const nliEnabled = nli !== null

  const empty = (candidates: number, degraded: boolean): EdgeDetectResult => ({
    proposals: [],
    candidates,
    pairs_evaluated: 0,
    degraded,
    nli_enabled: nliEnabled
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
  const contentById = new Map(candidates.map(c => [c.id, c.content]))
  const thresholds: NliThresholds = { contradictThreshold, supportThreshold }
  const proposals: EdgeProposal[] = []
  let pairsEvaluated = 0

  for (const pair of pairs) {
    if (proposals.length >= maxProposals) break
    if (excluded.has(pairKey(pair.source_id, pair.target_id))) continue
    pairsEvaluated++

    if (nli) {
      const proposal = await classifyPair(nli, pair, contentById, thresholds)
      if (proposal) proposals.push(proposal)
    } else {
      proposals.push({
        source_id: pair.source_id,
        target_id: pair.target_id,
        type: 'contradicts',
        confidence: pair.embeddingSimilarity,
        rationale: 'embedding_similarity_only',
        signals: { embeddingSimilarity: pair.embeddingSimilarity }
      })
    }
  }

  return {
    proposals,
    candidates: candidates.length,
    pairs_evaluated: pairsEvaluated,
    degraded: false,
    nli_enabled: nliEnabled
  }
}
