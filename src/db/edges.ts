import type { Database } from 'bun:sqlite'
import { v7 as uuidv7 } from 'uuid'
import { config } from '../config'
import { EdgeAlreadyExistsError, ClusterEdgeValidationError, SelfLoopEdgeError, EdgeConflictError } from './errors'
import { boostImportance, getThoughtRow, getThoughtsBatchWithTags, type Thought } from './thoughts'
import { placeholders } from './utils'

export { EdgeAlreadyExistsError, ClusterEdgeValidationError, SelfLoopEdgeError, EdgeConflictError }

export interface Edge {
  id: string
  source_id: string
  target_id: string
  type: string
  created_at: string
}

const VALID_EDGE_TYPES = new Set(['related', 'parent', 'replaces', 'develops', 'cluster', 'references', 'depends_on'])

export function isValidEdgeType(type: string): boolean {
  return VALID_EDGE_TYPES.has(type)
}

export function getValidEdgeTypes(): string[] {
  return [...VALID_EDGE_TYPES]
}

export function createEdge(db: Database, sourceId: string, targetId: string, type: string = 'related'): Edge {
  if (!isValidEdgeType(type)) {
    throw new Error(`Invalid edge type '${type}'. Valid types: ${getValidEdgeTypes().join(', ')}`)
  }
  if (type === 'child') {
    throw new ClusterEdgeValidationError(
      "Edge type 'child' is deprecated. Use 'parent' instead — 'parent' covers both directions."
    )
  }
  if (sourceId === targetId) {
    throw new SelfLoopEdgeError()
  }
  validateClusterConstraint(db, sourceId, targetId, type)

  const existing = findEdgeBetween(db, sourceId, targetId)
  if (existing) {
    if (existing.type === 'related' && type === 'related') {
      return existing
    }
    if (existing.source_id === sourceId && existing.target_id === targetId && existing.type === type) {
      throw new EdgeAlreadyExistsError()
    }
    throw new EdgeConflictError(sourceId, targetId)
  }

  const id = uuidv7()
  const now = new Date().toISOString()

  const createInTx = db.transaction(() => {
    try {
      db.prepare(`
        INSERT INTO edges (id, source_id, target_id, type, created_at)
        VALUES (?, ?, ?, ?, ?)
      `).run(id, sourceId, targetId, type, now)
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err)
      if (msg.includes('UNIQUE')) throw new EdgeAlreadyExistsError()
      throw err
    }
    boostImportance(db, sourceId, 0.1)
  })
  createInTx()

  return findEdge(db, id)
}

export function deleteEdge(db: Database, id: string): boolean {
  const result = db.prepare('DELETE FROM edges WHERE id = ?').run(id)
  return result.changes > 0
}

export function getEdgesForThought(db: Database, id: string): Edge[] {
  return db
    .prepare(`
    SELECT * FROM edges WHERE source_id = ? OR target_id = ?
  `)
    .all(id, id) as Edge[]
}

function isClusterThought(db: Database, id: string): boolean {
  const row = db.prepare('SELECT is_cluster FROM thoughts WHERE id = ?').get(id) as { is_cluster: number } | undefined
  return row?.is_cluster === 1
}

function validateClusterConstraint(db: Database, sourceId: string, targetId: string, type: string): void {
  const srcCluster = isClusterThought(db, sourceId)
  const tgtCluster = isClusterThought(db, targetId)

  if (type === 'cluster') {
    if (!srcCluster)
      throw new ClusterEdgeValidationError(
        "Only cluster thoughts can create 'cluster' edges (to add members). To link this thought to a cluster, the edge must originate from the cluster thought with a non-cluster target."
      )
    if (tgtCluster)
      throw new ClusterEdgeValidationError(
        "Cluster edges cannot target another cluster thought. Use 'references' to link two clusters together."
      )
    return
  }

  if (type === 'references') {
    if (srcCluster && !tgtCluster)
      throw new ClusterEdgeValidationError(
        "Clusters can reference only other clusters via 'references'. If you want to link a non-cluster thought to this cluster, use 'cluster' edge type from the cluster."
      )
    if (!srcCluster && tgtCluster)
      throw new ClusterEdgeValidationError(
        "Non-cluster thoughts cannot use 'references' to link to clusters. To add this thought to a cluster, the cluster thought needs an outgoing 'cluster' edge with this as target."
      )
    return
  }

  if (srcCluster)
    throw new ClusterEdgeValidationError(
      `Cluster thoughts cannot have '${type}' edges. Cluster thoughts can only use 'cluster' (to link members) or 'references' (between clusters) edge types.`
    )
  if (tgtCluster)
    throw new ClusterEdgeValidationError(
      `Cannot link to cluster thought using '${type}' edge. The only way to connect to a cluster is via 'cluster' edge type — which must originate FROM the cluster thought TO a non-cluster thought (to add it as a member). Non-cluster and cluster thoughts cannot be connected with '${type}' edges.`
    )
}

export function getAllActiveEdges(db: Database): Edge[] {
  return db
    .prepare(`
    SELECT e.* FROM edges e
    INNER JOIN thoughts s ON e.source_id = s.id
    INNER JOIN thoughts t ON e.target_id = t.id
    WHERE s.status = 'active' AND t.status = 'active'
  `)
    .all() as Edge[]
}

function findEdge(db: Database, id: string): Edge {
  return db.prepare('SELECT * FROM edges WHERE id = ?').get(id) as Edge
}

function findEdgeBetween(db: Database, sourceId: string, targetId: string): Edge | undefined {
  return db
    .prepare('SELECT * FROM edges WHERE (source_id = ? AND target_id = ?) OR (source_id = ? AND target_id = ?)')
    .get(sourceId, targetId, targetId, sourceId) as Edge | undefined
}

// --- Graph helpers ---

export interface EdgeView {
  id: string
  source: string
  target: string
  type: string
  created_at: string
}

export function toEdgeView(edge: Edge): EdgeView {
  return { id: edge.id, source: edge.source_id, target: edge.target_id, type: edge.type, created_at: edge.created_at }
}

export interface ThoughtEdgeResult {
  thought: Thought
  upstream: Array<{ edge: EdgeView; thought: Thought | undefined }>
  downstream: Array<{ edge: EdgeView; thought: Thought | undefined }>
}

export function getThoughtEdges(
  db: Database,
  id: string,
  direction: 'upstream' | 'downstream' | 'both' = 'both',
  maxDegree: number = config.graph.maxDegree
): ThoughtEdgeResult | null {
  const thought = getThoughtRow(db, id)
  if (!thought) return null

  let rawEdges = getEdgesForThought(db, id)

  if (rawEdges.length > maxDegree) {
    rawEdges.sort((a, b) => b.created_at.localeCompare(a.created_at))
    rawEdges = rawEdges.slice(0, maxDegree)
  }

  const involvedIds = new Set<string>()
  for (const e of rawEdges) {
    if (e.source_id === id) involvedIds.add(e.target_id)
    if (e.target_id === id) involvedIds.add(e.source_id)
  }

  const thoughtMap = getThoughtsBatchWithTags(db, [...involvedIds])

  const upstream: ThoughtEdgeResult['upstream'] = []
  const downstream: ThoughtEdgeResult['downstream'] = []

  for (const raw of rawEdges) {
    const edge = toEdgeView(raw)
    if (raw.target_id === id && thoughtMap.has(raw.source_id)) {
      upstream.push({ edge, thought: thoughtMap.get(raw.source_id) })
    }
    if (raw.source_id === id && thoughtMap.has(raw.target_id)) {
      downstream.push({ edge, thought: thoughtMap.get(raw.target_id) })
    }
  }

  if (direction === 'upstream') return { thought, upstream, downstream: [] }
  if (direction === 'downstream') return { thought, upstream: [], downstream }
  return { thought, upstream, downstream }
}

// --- Cluster helpers ---

export function getClusterForThought(db: Database, thoughtId: string): Thought | null {
  const edge = db.prepare(`SELECT source_id FROM edges WHERE target_id = ? AND type = 'cluster'`).get(thoughtId) as
    | { source_id: string }
    | undefined
  if (!edge) return null
  return getThoughtRow(db, edge.source_id) ?? null
}

export function getClusterForThoughtBatch(db: Database, thoughtIds: string[]): Map<string, Thought> {
  const result = new Map<string, Thought>()
  if (thoughtIds.length === 0) return result
  const ph = placeholders(thoughtIds)
  const edges = db
    .prepare(`SELECT target_id, source_id FROM edges WHERE target_id IN (${ph}) AND type = 'cluster'`)
    .all(...thoughtIds) as Array<{ target_id: string; source_id: string }>
  if (edges.length === 0) return result
  const clusterIds = [...new Set(edges.map(e => e.source_id))]
  const clusterMap = getThoughtsBatchWithTags(db, clusterIds)
  for (const e of edges) {
    const cluster = clusterMap.get(e.source_id)
    if (cluster) result.set(e.target_id, cluster)
  }
  return result
}

export function getClusterMembers(db: Database, clusterId: string): Thought[] {
  const edges = db.prepare(`SELECT target_id FROM edges WHERE source_id = ? AND type = 'cluster'`).all(clusterId) as {
    target_id: string
  }[]
  const members = getThoughtsBatchWithTags(db, edges.map(e => e.target_id))
  return edges.map(e => members.get(e.target_id)).filter(Boolean) as Thought[]
}
