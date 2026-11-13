import type { Database } from 'bun:sqlite'
import { ValidationError } from '../errors'
import { ClusterEdgeValidationError, InvalidEdgeTypeError } from './errors'
import type { Edge } from './edges'

export const EDGE_TYPES = [
  'related',
  'parent',
  'replaces',
  'develops',
  'cluster',
  'references',
  'depends_on',
  'contradicts',
  'supports'
] as const

export type EdgeType = (typeof EDGE_TYPES)[number]

const VALID_EDGE_TYPES = new Set<string>(EDGE_TYPES)

export const SYMMETRIC_EDGE_TYPES = new Set(['related', 'contradicts'])

export function isValidEdgeType(type: string): boolean {
  return VALID_EDGE_TYPES.has(type)
}

export function validateRetype(db: Database, edge: Edge, newType: string): void {
  if (!isValidEdgeType(newType)) {
    throw new InvalidEdgeTypeError(newType, [...EDGE_TYPES])
  }
  if (edge.type === newType) {
    throw new ValidationError(`Edge ${edge.id} is already of type '${newType}'`)
  }
  validateClusterConstraint(db, edge.source_id, edge.target_id, newType)
}

function isClusterThought(db: Database, id: string): boolean {
  const row = db.prepare('SELECT is_cluster FROM thoughts WHERE id = ?').get(id) as
    | { is_cluster: number }
    | undefined
  return row?.is_cluster === 1
}

export function validateClusterConstraint(
  db: Database,
  sourceId: string,
  targetId: string,
  type: string
): void {
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
