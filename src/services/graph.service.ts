import { getAllActiveEdges, getThoughtEdges, type EdgeView } from '../db/edges'
import { getDb } from '../db'
import { searchThoughts } from '../db/search'
import { listThoughts, type Thought } from '../db/thoughts'

export interface GraphNode {
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

export interface GraphEdge {
  id: string
  source: string
  target: string
  type: string
}

export interface GraphData {
  nodes: GraphNode[]
  edges: GraphEdge[]
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

export function getGraphDataService(projectId?: string | null, status: string = 'active', limit: number | null = null): GraphData {
  const d = getDb()
  const thoughts = listThoughts(d, {
    status: status === 'all' ? undefined : status,
    project_id: projectId ?? undefined,
    limit: limit
  })
  const thoughtIds = new Set(thoughts.map(t => t.id))
  const edges = getAllActiveEdges(d).filter(e => thoughtIds.has(e.source_id) && thoughtIds.has(e.target_id))

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
    }))
  }
}

export interface ChainResult {
  thought: Thought
  upstream: Array<{ edge: EdgeView; thought: Thought | undefined }>
  downstream: Array<{ edge: EdgeView; thought: Thought | undefined }>
}

export function getChainService(
  thoughtId: string,
  direction: 'upstream' | 'downstream' | 'both' = 'both'
): ChainResult | null {
  return getThoughtEdges(getDb(), thoughtId, direction)
}

export interface ContextResult {
  best_match: Thought
  chain: ChainResult | null
}

export function getContextService(query: string): ContextResult | null {
  const d = getDb()
  const results = searchThoughts(d, { embedding: new Float32Array(0), query, topK: 1, hybrid: true, statusFilter: 'active' })
  if (!results || results.length === 0) return null
  const best = results[0].thought ?? results[0]
  const chain = getThoughtEdges(d, best.id, best.is_cluster ? 'downstream' : 'both')
  return { best_match: best, chain }
}
