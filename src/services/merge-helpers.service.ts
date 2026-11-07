import type { Database } from 'bun:sqlite'
import { getDb } from '../db'
import { createEdge, deleteEdge, getEdgesForThought, type Edge } from '../db/edges'
import { getThoughtRow, type Thought } from '../db/thoughts'
import { insertLog } from '../logging/log'
import { EdgeAlreadyExistsError, ValidationError } from '../errors'

export function validateMergePreconditions(source: Thought, allowArchivedSource = false): void {
  if (source.status === 'archived' && !allowArchivedSource) {
    throw new ValidationError('Source thought is already archived')
  }
}

/**
 * Log that a remapped edge is a duplicate on the target and was skipped. Shared
 * by the cluster and non-cluster branches (DRY).
 */
function logSkippedDuplicateEdge(
  edge: Edge,
  newSourceId: string,
  newTargetId: string,
  targetId: string,
  sourceId: string
): void {
  insertLog(
    'warning',
    'thought',
    `Merge: edge ${edge.id} (${edge.type}) already exists between ${newSourceId} and ${newTargetId} — skipped`,
    {
      target_id: targetId,
      source_id: sourceId,
      edge_id: edge.id,
      edge_type: edge.type
    }
  )
}

/**
 * Attempt to create a remapped edge; returns true on success, false on a
 * duplicate (logged). Any other error propagates. Shared by the cluster and
 * non-cluster branches (DRY).
 */
function tryCreateRemappedEdge(
  d: Database,
  newSourceId: string,
  newTargetId: string,
  type: string,
  edge: Edge,
  targetId: string,
  sourceId: string
): boolean {
  try {
    createEdge(d, newSourceId, newTargetId, type)
    return true
  } catch (err) {
    if (!(err instanceof EdgeAlreadyExistsError)) throw err
    logSkippedDuplicateEdge(edge, newSourceId, newTargetId, targetId, sourceId)
    return false
  }
}

export function transferEdgesFromSource(sourceId: string, targetId: string, d: Database = getDb()): number {
  const edgesToTransfer = getEdgesForThought(d, sourceId)
  let transferredEdges = 0

  for (const edge of edgesToTransfer) {
    const isClusterEdge = edge.type === 'cluster'
    const newSourceId = edge.source_id === sourceId ? targetId : edge.source_id
    const newTargetId = edge.target_id === sourceId ? targetId : edge.target_id

    // An edge that pointed at the source from the target (or vice versa)
    // collapses onto itself after remapping — a self-relation carries no
    // information. Log it and skip recreation: the pair-edge to the archived
    // source is meaningless, and recreating it as target→target would fail
    // the merge.
    if (newSourceId === newTargetId) {
      insertLog(
        'info',
        'thought',
        `Merge: dropped edge ${edge.id} (${edge.type}) between ${targetId} and merged source ${sourceId}`,
        {
          target_id: targetId,
          source_id: sourceId,
          edge_id: edge.id,
          edge_type: edge.type
        }
      )
      // Fall through to the uniform delete below.
    } else if (isClusterEdge) {
      const srcRow = getThoughtRow(d, newSourceId)
      const tgtRow = srcRow?.is_cluster ? getThoughtRow(d, newTargetId) : undefined
      if (srcRow?.is_cluster && !tgtRow?.is_cluster) {
        if (tryCreateRemappedEdge(d, newSourceId, newTargetId, edge.type, edge, targetId, sourceId)) {
          transferredEdges++
        }
      }
      // Otherwise fall through to the uniform delete below.
    } else {
      if (tryCreateRemappedEdge(d, newSourceId, newTargetId, edge.type, edge, targetId, sourceId)) {
        transferredEdges++
      }
    }

    // After handling each edge, delete the original row owned by the source.
    // The source will be archived shortly after this function returns, so any
    // remaining edges from it are noise in the health audit.
    deleteEdge(d, edge.id)
  }

  return transferredEdges
}
