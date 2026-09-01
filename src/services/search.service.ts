import { getClusterForThoughtBatch } from '../db/edges'
import { getDb } from '../db'
import { type SearchResult, searchThoughts as dbSearchThoughts } from '../db/search'
import { getThoughtTagsBatch } from '../db/tags'
import { getThought, parseTags } from '../db/thoughts'
import type { Database } from 'bun:sqlite'
import { generateEmbedding } from '../embedder/client'

const EMBEDDING_TIMEOUT_MS = 5_000

async function generateEmbeddingWithFallback(query: string): Promise<Float32Array> {
  try {
    return await Promise.race([
      generateEmbedding(query),
      new Promise<never>((_, reject) =>
        setTimeout(() => reject(new Error('Embedding timeout')), EMBEDDING_TIMEOUT_MS)
      )
    ])
  } catch (err) {
    console.error('[search] embedding generation failed, falling back to BM25:', err instanceof Error ? err.message : err)
    return new Float32Array(0)
  }
}

export interface SearchServiceOptions {
  query: string
  topK?: number
  statusFilter?: string
  projectFilter?: string
  tagFilter?: string
  clusterFilter?: 'only' | 'exclude'
  minImportance?: number
  excludeFlagged?: boolean
  hybrid?: boolean
}

export interface GroupedResult {
  thought?: SearchResult['thought']
  cluster?: { id: string; content: string }
  items?: SearchResult[]
}

export async function searchThoughts(options: SearchServiceOptions): Promise<SearchResult[]> {
  const d = getDb()
  const embedding = await generateEmbeddingWithFallback(options.query)
  const results = dbSearchThoughts(d, {
    embedding,
    query: options.query,
    topK: options.topK ?? 10,
    statusFilter: options.statusFilter,
    projectFilter: options.projectFilter,
    clusterFilter: options.clusterFilter,
    minImportance: options.minImportance,
    excludeFlagged: options.excludeFlagged,
    hybrid: options.hybrid
  })

  return options.tagFilter
    ? filterByTags(results, options.tagFilter, d)
    : results
}

export async function searchThoughtsGrouped(options: SearchServiceOptions): Promise<GroupedResult[]> {
  const flat = await searchThoughts(options)
  return groupResultsByCluster(flat)
}

function filterByTags(results: SearchResult[], tagFilter: string, d: Database): SearchResult[] {
  const tagNames = parseTags(tagFilter)
  if (!tagNames || tagNames.length === 0) return results
  const tagMap = getThoughtTagsBatch(d, results.map(r => r.thought.id))
  return results.filter(r => {
    const tags = tagMap.get(r.thought.id) ?? []
    const thoughtTagNames = new Set(tags.map(t => t.name.toLowerCase()))
    return tagNames.every(n => thoughtTagNames.has(n.toLowerCase()))
  })
}

export function groupResultsByCluster(results: SearchResult[]): GroupedResult[] {
  const d = getDb()
  const clusterMap = new Map<string, SearchResult[]>()
  const nonCluster: SearchResult[] = []

  const clusterByThought = getClusterForThoughtBatch(d, results.map(r => r.thought.id))

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
    const clusterThought = getThought(d, clusterId)
    if (clusterThought) {
      grouped.push({
        cluster: { id: clusterThought.id, content: clusterThought.content },
        items
      })
    }
  }

  return grouped
}
