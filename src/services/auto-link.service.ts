import { config } from '../config'
import { findLinkCandidates as dbFindLinkCandidates, type LinkCandidate } from '../db/auto-link'
import { createEdge, type Edge } from '../db/edges'
import { getDb } from '../db'
import { recordJobRun } from '../db/meta'
import { searchThoughts } from '../db/search'
import { pairKey } from '../db/utils'
import { generateEmbeddings } from '../embedder/client'
import { insertLog } from '../logging/log'
import { findEmbeddingNeighborPairs } from './edge-candidates.service'
import type { Database } from 'bun:sqlite'

// ── Types ────────────────────────────────────────────────────────────────────

interface AutoLinkOptions {
  minSimilarity?: number
  maxEdgesPerRun?: number
  dryRun?: boolean
}

export interface CandidatePair {
  source_id: string
  target_id: string
  embeddingSimilarity: number
  score: number
}

interface AutoLinkResult {
  dry_run: boolean
  candidates: number
  pairs_found: number
  edges_created: number
  pairs: CandidatePair[]
}

/** Injected dependencies for testing. */
export interface AutoLinkDeps {
  embed?: (texts: string[]) => Promise<Float32Array[]>
  searchNeighbors?: (
    thoughtId: string,
    embedding: Float32Array,
    topK: number
  ) => Array<{ id: string; distance: number }>
}

// ── Candidate selection ──────────────────────────────────────────────────────

/**
 * Find active, non-cluster thoughts with low connectivity (< 3 related edges).
 * These are the best candidates for auto-linking.
 */
export function findLinkCandidates(d: Database = getDb()): LinkCandidate[] {
  return dbFindLinkCandidates(d)
}

// ── Embedding proximity pairs ────────────────────────────────────────────────

/**
 * Find candidate pairs from embedding proximity. For each candidate, search
 * for neighbors using vector search and collect pairs within minSimilarity.
 * Delegates the generic neighbour-pair step to `edge-candidates.service`.
 */
function findEmbeddingPairs(
  candidates: Array<{ id: string; content: string }>,
  embeddings: Float32Array[],
  minSimilarity: number,
  d: Database
): CandidatePair[] {
  const pairs = findEmbeddingNeighborPairs(
    candidates,
    embeddings,
    minSimilarity,
    (_id, embedding) => {
      try {
        return searchThoughts(d, {
          embedding,
          topK: 20,
          statusFilter: 'active',
          hybrid: false
        }).map(r => ({ id: r.thought.id, similarity: r.similarity }))
      } catch {
        // vec_thoughts may not exist in :memory: tests — skip this candidate
        return []
      }
    }
  )

  return pairs.map(p => ({
    source_id: p.source_id,
    target_id: p.target_id,
    embeddingSimilarity: p.embeddingSimilarity,
    score: p.embeddingSimilarity
  }))
}

// ── Merge & score ────────────────────────────────────────────────────────────

/**
 * Deduplicate embedding pairs by unordered pair key (sorted), keeping the max
 * similarity per pair, then return the top-K pairs sorted by score descending.
 */
export function mergeCandidates(embeddingPairs: CandidatePair[], maxEdges: number): CandidatePair[] {
  const pairMap = new Map<string, CandidatePair>()

  for (const pair of embeddingPairs) {
    const key = pairKey(pair.source_id, pair.target_id)
    const existing = pairMap.get(key)
    if (!existing) {
      pairMap.set(key, { ...pair })
    } else {
      // Merge: keep the max similarity for the unordered pair.
      existing.embeddingSimilarity = Math.max(existing.embeddingSimilarity, pair.embeddingSimilarity)
      existing.score = existing.embeddingSimilarity
    }
  }

  // Sort by score descending, take top-K
  return [...pairMap.values()].sort((a, b) => b.score - a.score).slice(0, maxEdges)
}

// ── Edge creation ────────────────────────────────────────────────────────────

/**
 * Create `related` edges for the given pairs. Skips pairs where an edge
 * already exists (createEdge handles dedup).
 */
export function createEdges(pairs: CandidatePair[], d: Database = getDb()): Edge[] {
  const created: Edge[] = []
  for (const pair of pairs) {
    try {
      const edge = createEdge(d, pair.source_id, pair.target_id, 'related')
      created.push(edge)
    } catch {
      // EdgeAlreadyExistsError or EdgeConflictError — skip silently
    }
  }
  return created
}

// ── Run job ──────────────────────────────────────────────────────────────────

function recordRun(result: AutoLinkResult, db: Database): void {
  recordJobRun(db, 'last_auto_link', result)
}

/**
 * Main auto-link job: find low-connectivity thoughts, discover embedding
 * proximity pairs, create related edges.
 */
export async function runAutoLinkJob(
  options: AutoLinkOptions = {},
  deps: AutoLinkDeps = {},
  d: Database = getDb()
): Promise<AutoLinkResult> {
  const minSimilarity = options.minSimilarity ?? config.autoLink.minSimilarity
  const maxEdges = options.maxEdgesPerRun ?? config.autoLink.maxEdgesPerRun
  const dryRun = options.dryRun ?? config.autoLink.dryRun
  const embed = deps.embed ?? generateEmbeddings

  // 1. Find candidates
  const candidates = findLinkCandidates(d)
  if (candidates.length < 2) {
    const empty: AutoLinkResult = {
      dry_run: dryRun,
      candidates: candidates.length,
      pairs_found: 0,
      edges_created: 0,
      pairs: []
    }
    recordRun(empty, d)
    return empty
  }

  // 2. Embedding pairs (requires embedding generation)
  let embeddingPairs: CandidatePair[] = []
  try {
    const embeddings = await embed(candidates.map(c => c.content))
    embeddingPairs = findEmbeddingPairs(candidates, embeddings, minSimilarity, d)
  } catch (err) {
    console.error('[auto-link] embedding search failed:', err)
  }

  // 3. Merge & score
  const pairs = mergeCandidates(embeddingPairs, maxEdges)

  // 4. Create edges
  let created: Edge[] = []
  if (!dryRun && pairs.length > 0) {
    created = createEdges(pairs, d)
  }

  const result: AutoLinkResult = {
    dry_run: dryRun,
    candidates: candidates.length,
    pairs_found: pairs.length,
    edges_created: created.length,
    pairs
  }

  recordRun(result, d)
  insertLog(
    'info',
    'auto_link',
    `Auto-link run: ${candidates.length} candidates, ${pairs.length} pairs, ${created.length} edges`,
    { dry_run: dryRun, edges_created: created.length }
  )

  return result
}
