import { getClusterForThoughtBatch } from '../db/cluster-edges'
import { getDb } from '../db'
import { type SearchResult, searchThoughts as dbSearchThoughts } from '../db/search'
export type { SearchResult } from '../db/search'
import type { Thought } from '../db/thoughts'
import type { Database } from 'bun:sqlite'
import { generateEmbedding } from '../embedder/client'
import {
  type IdLookup,
  idNotFoundWarning,
  keepsUnderRelevanceGate,
  runIdLookup,
  type SearchOutcome
} from './search-outcome.service'
import { normalizeSearchOptions, type NormalizedSearchOptions } from './search-normalize.service'
import { applyGraphStanding } from './search-standing.service'
import { calibrateRelevance } from './text-similarity.service'

export type { SearchOutcome, SearchOutcomeReason } from './search-outcome.service'

const EMBEDDING_TIMEOUT_MS = 5_000

async function generateEmbeddingWithFallback(
  query: string
): Promise<{ embedding: Float32Array; degraded: boolean }> {
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
    console.error(
      '[search] embedding generation failed, falling back to BM25:',
      err instanceof Error ? err.message : err
    )
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
  supersessionMode?: SupersessionMode
  contradictionMode?: ContradictionMode
  embedding?: Float32Array
  recencyWeight?: number
  recencyHalfLifeDays?: number
  minRelevance?: number
  confidenceFloor?: number
}

export interface GroupedResult {
  thought?: SearchResult['thought']
  cluster?: { id: string; content: string }
  items?: SearchResult[]
}

interface SearchRun extends SearchOutcome {
  degraded: boolean
}

async function runSearch(options: SearchServiceOptions, d: Database): Promise<SearchRun> {
  const normalized = normalizeSearchOptions(options)
  const idLookup = runIdLookup(options.query, d, normalized.topK, {
    statusFilter: options.statusFilter,
    projectFilter: options.projectFilter,
    clusterFilter: options.clusterFilter,
    minImportance: normalized.minImportance,
    tagFilter: options.tagFilter
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
    tagFilter: options.tagFilter,
    hybrid: options.hybrid,
    recencyWeight,
    recencyHalfLifeDays,
    confidenceFloor
  })
  const dbDegraded = (dbResults as { degraded?: boolean }).degraded === true

  for (const result of dbResults) {
    if (result.similarity !== undefined) {
      result.relevance = calibrateRelevance(result.similarity, unrelatedFloor, confidenceFloor)
    }
  }

  const standing = applyGraphStanding(dbResults, options, d)
  const gated = standing.filter(r => keepsUnderRelevanceGate(r, minRelevance))
  const finalResults = gated.length > topK ? gated.slice(0, topK) : gated
  const degraded = embeddingDegraded || dbDegraded
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
    if (standing.length === 0) outcome.reason = 'id_not_found'
  }
  return outcome
}

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

export async function searchThoughts(
  options: SearchServiceOptions,
  d: Database = getDb()
): Promise<SearchResult[]> {
  const { items, degraded } = await runSearch(options, d)
  Object.assign(items, { degraded })
  return items
}

export async function searchThoughtsOutcome(
  options: SearchServiceOptions,
  d: Database = getDb()
): Promise<SearchOutcome> {
  const { items, degraded, ...outcome } = await runSearch(options, d)
  Object.assign(items, { degraded })
  return { ...outcome, items }
}

export function groupResultsByCluster(
  results: SearchResult[],
  d: Database = getDb()
): GroupedResult[] {
  const clusterMap = new Map<string, SearchResult[]>()
  const nonCluster: SearchResult[] = []

  const clusterByThought = getClusterForThoughtBatch(
    d,
    results.map(r => r.thought.id)
  )

  const clusterThoughtById = new Map<string, Thought>()
  for (const cluster of clusterByThought.values()) {
    if (!clusterThoughtById.has(cluster.id)) clusterThoughtById.set(cluster.id, cluster)
  }

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
    const clusterThought = clusterThoughtById.get(clusterId)
    if (clusterThought) {
      grouped.push({
        cluster: { id: clusterThought.id, content: clusterThought.content },
        items
      })
    }
  }

  return grouped
}
