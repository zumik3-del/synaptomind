import { config } from '../config'
import { sqlIn } from '../db/utils'
import { createEdge, type Edge } from '../db/edges'
import { getDb } from '../db'
import { searchThoughts } from '../db/search'
import { generateEmbeddings } from '../embedder/client'
import { insertLog } from '../logging/log'
import { recordJobRun, getLastJobRun } from './utils'
import { findEmbeddingNeighborPairs } from './edge-candidates.service'
import type { Database } from 'bun:sqlite'

// ── Types ────────────────────────────────────────────────────────────────────

export interface AutoLinkOptions {
  minSimilarity?: number
  maxEdgesPerRun?: number
  minEntityOverlap?: number
  dryRun?: boolean
}

export interface CandidatePair {
  source_id: string
  target_id: string
  entityOverlap: number
  embeddingSimilarity: number
  score: number
}

export interface AutoLinkResult {
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
export function findLinkCandidates(): Array<{ id: string; content: string; edge_count: number }> {
  const d = getDb()
  return d
    .prepare(`
    SELECT id, content, edge_count FROM (
      SELECT t.id, t.content, t.created_at,
             (SELECT COUNT(*) FROM edges e
              WHERE (e.source_id = t.id OR e.target_id = t.id)
                AND e.type = 'related') as edge_count
      FROM thoughts t
      WHERE t.status = 'active'
        AND (t.is_cluster IS NULL OR t.is_cluster = 0)
        AND NOT EXISTS (
          SELECT 1 FROM edges e WHERE e.type = 'cluster' AND e.target_id = t.id
        )
    ) sub
    WHERE edge_count < 3
    ORDER BY edge_count ASC, created_at DESC
  `)
    .all() as Array<{ id: string; content: string; edge_count: number }>
}

// ── Entity overlap pairs ─────────────────────────────────────────────────────

/**
 * Find candidate pairs from shared entities. Returns pairs with overlap count.
 * Only considers candidate thought IDs.
 */
export function findEntityPairs(candidateIds: string[]): CandidatePair[] {
  if (candidateIds.length < 2) return []

  const d = getDb()
  const ph = sqlIn(candidateIds)

  const rows = d
    .prepare(`
    SELECT e1.thought_id as source_id, e2.thought_id as target_id,
           COUNT(DISTINCT e1.entity_name) as overlap
    FROM thought_entities e1
    JOIN thought_entities e2
      ON e1.entity_name = e2.entity_name
      AND e1.thought_id < e2.thought_id
      AND e2.thought_id IN (${ph})
    WHERE e1.thought_id IN (${ph})
    GROUP BY e1.thought_id, e2.thought_id
    ORDER BY overlap DESC
  `)
    .all(...candidateIds, ...candidateIds) as Array<{
    source_id: string
    target_id: string
    overlap: number
  }>

  return rows.map(r => ({
    source_id: r.source_id,
    target_id: r.target_id,
    entityOverlap: r.overlap,
    embeddingSimilarity: 0,
    score: r.overlap * 2
  }))
}

// ── Embedding proximity pairs ────────────────────────────────────────────────

/**
 * Find candidate pairs from embedding proximity. For each candidate, search
 * for neighbors using vector search and collect pairs within minSimilarity.
 * Delegates the generic neighbour-pair step to `edge-candidates.service`.
 */
export function findEmbeddingPairs(
  candidates: Array<{ id: string; content: string }>,
  embeddings: Float32Array[],
  minSimilarity: number
): CandidatePair[] {
  const d = getDb()
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
    entityOverlap: 0,
    embeddingSimilarity: p.embeddingSimilarity,
    score: p.embeddingSimilarity
  }))
}

// ── Merge & score ────────────────────────────────────────────────────────────

/**
 * Merge entity and embedding pairs. Union-Find deduplicates, score combines
 * both signals. Returns top-K pairs sorted by score descending.
 */
export function mergeCandidates(
  entityPairs: CandidatePair[],
  embeddingPairs: CandidatePair[],
  maxEdges: number
): CandidatePair[] {
  const pairMap = new Map<string, CandidatePair>()

  // Index all pairs by sorted key
  const upsert = (pair: CandidatePair): void => {
    const key = [pair.source_id, pair.target_id].sort().join('::')
    const existing = pairMap.get(key)
    if (!existing) {
      pairMap.set(key, { ...pair })
    } else {
      // Merge: take max of each signal
      existing.entityOverlap = Math.max(existing.entityOverlap, pair.entityOverlap)
      existing.embeddingSimilarity = Math.max(existing.embeddingSimilarity, pair.embeddingSimilarity)
      existing.score = existing.entityOverlap * 2 + existing.embeddingSimilarity
    }
  }

  for (const p of entityPairs) upsert(p)
  for (const p of embeddingPairs) upsert(p)

  // Sort by score descending, take top-K
  return [...pairMap.values()].sort((a, b) => b.score - a.score).slice(0, maxEdges)
}

// ── Edge creation ────────────────────────────────────────────────────────────

/**
 * Create `related` edges for the given pairs. Skips pairs where an edge
 * already exists (createEdge handles dedup).
 */
export function createEdges(pairs: CandidatePair[]): Edge[] {
  const d = getDb()
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

export function getLastAutoLinkStatus(): { last_run: string | null; result: AutoLinkResult | null } {
  return getLastJobRun<AutoLinkResult>(getDb(), 'last_auto_link')
}

/**
 * Main auto-link job: find low-connectivity thoughts, discover entity and
 * embedding proximity pairs, create related edges.
 */
export async function runAutoLinkJob(options: AutoLinkOptions = {}, deps: AutoLinkDeps = {}): Promise<AutoLinkResult> {
  const minSimilarity = options.minSimilarity ?? config.autoLink.minSimilarity
  const maxEdges = options.maxEdgesPerRun ?? config.autoLink.maxEdgesPerRun
  const dryRun = options.dryRun ?? config.autoLink.dryRun
  const embed = deps.embed ?? generateEmbeddings
  const d = getDb()

  // 1. Find candidates
  const candidates = findLinkCandidates()
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

  // 2. Entity pairs (cheap, always run)
  const entityPairs = findEntityPairs(candidates.map(c => c.id))

  // 3. Embedding pairs (requires embedding generation)
  let embeddingPairs: CandidatePair[] = []
  try {
    const embeddings = await embed(candidates.map(c => c.content))
    embeddingPairs = findEmbeddingPairs(candidates, embeddings, minSimilarity)
  } catch (err) {
    console.error('[auto-link] embedding search failed, falling back to entity-only:', err)
  }

  // 4. Merge & score
  const pairs = mergeCandidates(entityPairs, embeddingPairs, maxEdges)

  // 5. Create edges
  let created: Edge[] = []
  if (!dryRun && pairs.length > 0) {
    created = createEdges(pairs)
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
