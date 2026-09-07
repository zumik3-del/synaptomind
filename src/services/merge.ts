import type { Database } from 'bun:sqlite'
import { createEdge, deleteEdge, getEdgesForThought } from '../db/edges'
import { getThoughtRow, type Thought } from '../db/thoughts'
import { insertLog } from '../logging/log'
import { EdgeAlreadyExistsError, ValidationError } from '../errors'

export function validateMergePreconditions(source: Thought): void {
  if (source.status === 'archived') {
    throw new ValidationError('Source thought is already archived')
  }

  // Merge archives its source; profile thoughts are persona material and must
  // survive (issue #200). Merging *into* a profile thought is fine.
  if (source.is_profile) {
    throw new ValidationError('Cannot merge a profile thought away — clear the is_profile flag first')
  }
}

export function transferEdgesFromSource(db: Database, sourceId: string, targetId: string): number {
  const edgesToTransfer = getEdgesForThought(db, sourceId)
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
      const srcRow = getThoughtRow(db, newSourceId)
      if (!srcRow?.is_cluster) {
        // Fall through to the uniform delete below.
      } else {
        const tgtRow = getThoughtRow(db, newTargetId)
        if (tgtRow?.is_cluster) {
          // Fall through to the uniform delete below.
        } else {
          try {
            createEdge(db, newSourceId, newTargetId, edge.type)
            transferredEdges++
          } catch (err) {
            // A duplicate edge on the target is expected dedup — skip, don't
            // silently swallow. Anything else fails the merge atomically.
            if (!(err instanceof EdgeAlreadyExistsError)) throw err
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
        }
      }
    } else {
      try {
        createEdge(db, newSourceId, newTargetId, edge.type)
        transferredEdges++
      } catch (err) {
        // A duplicate edge on the target is expected dedup — skip, don't
        // silently swallow. Anything else fails the merge atomically.
        if (!(err instanceof EdgeAlreadyExistsError)) throw err
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
    }

    // After handling each edge, delete the original row owned by the source.
    // The source will be archived shortly after this function returns, so any
    // remaining edges from it are noise in the health audit.
    deleteEdge(db, edge.id)
  }

  return transferredEdges
}
