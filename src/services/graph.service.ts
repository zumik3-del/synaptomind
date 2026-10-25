import { getAllActiveEdges, getThoughtEdges, type EdgeView } from '../db/edges'
import { getDb } from '../db'
import { config } from '../config'
import { searchThoughts as searchThoughtsService } from './search.service'
import { countThoughts, listThoughts, type Thought } from '../db/thoughts'
import type { Database } from 'bun:sqlite'

interface GraphNode {
  id: string
  label: string
  title?: string
  group?: string
  tags?: string[]
  category?: string
  status?: string
  is_cluster?: boolean
  project_name?: string
}

interface GraphEdge {
  id: string
  source: string
  target: string
  type: string
}

interface GraphData {
  nodes: GraphNode[]
  edges: GraphEdge[]
  total: number
  limit: number
  offset: number
}

function resolveCategory(source: string | null, tags: string[], isCluster: number): string {
  if (isCluster) return 'cluster'
  if (source === 'mcp') return 'agent'
  if (source === 'api') return 'api'
  if (tags.some(t => ['concept', 'entity', 'fact', 'tech'].includes(t))) {
    if (tags.includes('entity')) return 'entity'
    return 'concept'
  }
  return 'concept'
}

const GRAPH_DEFAULT_LIMIT = 500
const GRAPH_MAX_LIMIT = 2000

function resolveGraphLimit(limit: number | null | undefined): number {
  if (limit === null || limit === undefined) return GRAPH_DEFAULT_LIMIT
  if (!Number.isFinite(limit)) return GRAPH_DEFAULT_LIMIT
  return Math.min(Math.max(Math.floor(limit), 1), GRAPH_MAX_LIMIT)
}

const GRAPH_DEFAULT_OFFSET = 0
const GRAPH_MAX_OFFSET = 1_000_000

function resolveGraphOffset(offset: number | null | undefined): number {
  if (offset === null || offset === undefined) return GRAPH_DEFAULT_OFFSET
  if (!Number.isFinite(offset)) return GRAPH_DEFAULT_OFFSET
  return Math.min(Math.max(Math.floor(offset), 0), GRAPH_MAX_OFFSET)
}

export function getGraphDataService(
  projectId?: string | null,
  status: string = 'active',
  limit: number | null = null,
  offsetOrDb?: number | Database | null,
  d: Database = getDb()
): GraphData {
  // Backward-compatible: a Database passed as the 4th arg (legacy DI style) is
  // treated as the db handle with offset 0.
  let offset: number | null = null
  let db: Database = d
  if (offsetOrDb !== null && offsetOrDb !== undefined && typeof offsetOrDb === 'object' && 'prepare' in (offsetOrDb as object)) {
    db = offsetOrDb as Database
  } else {
    offset = offsetOrDb as number | null
  }

  const effectiveLimit = resolveGraphLimit(limit)
  const effectiveOffset = resolveGraphOffset(offset)
  const filters = {
    status: status === 'all' ? undefined : status,
    project_id: projectId ?? undefined
  }
  const thoughts = listThoughts(db, {
    ...filters,
    limit: effectiveLimit,
    offset: effectiveOffset
  })
  const total = countThoughts(db, filters)
  const thoughtIds = new Set(thoughts.map(t => t.id))
  const edges = getAllActiveEdges(db).filter(e => thoughtIds.has(e.source_id) && thoughtIds.has(e.target_id))

  return {
    nodes: thoughts.map(t => {
      const tags = t.tags.map(tag => tag.name)
      return {
        id: t.id,
        label: t.content.length > 60 ? `${t.content.slice(0, 60)}…` : t.content,
        title: t.content,
        group: t.source ?? undefined,
        tags,
        category: resolveCategory(t.source, tags, t.is_cluster),
        status: t.status,
        is_cluster: t.is_cluster === 1,
        project_name: t.project_name
      }
    }),
    edges: edges.map(e => ({
      id: e.id,
      source: e.source_id,
      target: e.target_id,
      type: e.type
    })),
    total,
    limit: effectiveLimit,
    offset: effectiveOffset
  }
}

export interface ChainResult {
  thought: Thought
  upstream: Array<{ edge: EdgeView; thought: Thought | undefined }>
  downstream: Array<{ edge: EdgeView; thought: Thought | undefined }>
}

export function getChainService(
  thoughtId: string,
  direction: 'upstream' | 'downstream' | 'both' = 'both',
  maxDegree: number = config.graph.maxDegree,
  d: Database = getDb()
): ChainResult | null {
  return getThoughtEdges(d, thoughtId, direction, maxDegree)
}

interface ContextResult {
  best_match?: Thought
  chain?: ChainResult | null
  degraded?: boolean
}

export async function getContextService(
  query: string,
  maxDegree: number = config.graph.maxDegree,
  projectFilter?: string,
  d: Database = getDb()
): Promise<ContextResult | null> {
  const results = await searchThoughtsService({
    query,
    topK: 1,
    hybrid: true,
    statusFilter: 'active',
    projectFilter
  }, d)
  if (!results || results.length === 0) {
    // Surface degradation instead of throwing: when the search degraded, return
    // a degraded-only result so callers can observe it rather than NotFoundError.
    const degraded = (results as { degraded?: boolean }).degraded === true
    if (degraded) {
      return { degraded }
    }
    return null
  }
  const best = results[0].thought ?? (results[0] as unknown as Thought)
  const degraded = results[0].degraded === true || (results as { degraded?: boolean }).degraded === true
  const chain = getThoughtEdges(d, best.id, best.is_cluster ? 'downstream' : 'both', maxDegree)
  return { best_match: best, chain, degraded }
}
