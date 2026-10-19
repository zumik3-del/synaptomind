/**
 * Edge-type vocabulary and validation rules, split out of `edges.ts` so that
 * module keeps its persistence/queries focus and stays under the project's
 * 350-line file convention (AGENTS.md §4).
 *
 * Everything here is a pure rule over the `edges`/`thoughts` rows — no insert,
 * no delete. `edges.ts` re-exports every symbol below, so services, the MCP zod
 * enums and the docs keep importing them from `../db/edges` unchanged.
 *
 * `Edge` is imported type-only, so there is no runtime edge back to `edges.ts`
 * (erased under `isolatedModules`); persistence (insert/replace/delete) stays
 * there, which is why `retypeEdge` remains in `edges.ts` — it needs `findEdge`
 * and `replaceEdge`.
 */

import type { Database } from 'bun:sqlite'
import { ValidationError } from '../errors'
import { ClusterEdgeValidationError, InvalidEdgeTypeError } from './errors'
import type { Edge } from './edges'

/**
 * Canonical list of edge types — the single source of truth. The validity Set
 * below, the MCP zod enums (re-exported via services/edges.service.ts) and the
 * docs all derive from it, so the list can never drift again.
 */
export const EDGE_TYPES = [
  'related', 'parent', 'replaces', 'develops', 'cluster', 'references', 'depends_on',
  'contradicts', 'supports',
] as const

export type EdgeType = (typeof EDGE_TYPES)[number]

const VALID_EDGE_TYPES = new Set<string>(EDGE_TYPES)

/**
 * Symmetric types carry no direction: `A contradicts B` <=> `B contradicts A`.
 * They are stored as a single row per unordered pair and creation is idempotent
 * in both directions. Directed types (`supports`, `parent`, ...) follow the
 * strict one-edge-per-pair rule and reject a reverse duplicate with a conflict.
 */
export const SYMMETRIC_EDGE_TYPES = new Set(['related', 'contradicts'])

export function isValidEdgeType(type: string): boolean {
  return VALID_EDGE_TYPES.has(type)
}

/**
 * Shared retype validation: valid type, not same-type, cluster constraints.
 * Called by retypeEdge (confirm) and the MCP dry-run so both paths reject
 * identically (ADR §2) — a preview must never promise a confirm would reject.
 */
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
  const row = db.prepare('SELECT is_cluster FROM thoughts WHERE id = ?').get(id) as { is_cluster: number } | undefined
  return row?.is_cluster === 1
}

export function validateClusterConstraint(db: Database, sourceId: string, targetId: string, type: string): void {
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