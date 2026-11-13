import type { Database } from 'bun:sqlite'
import { getDb } from '../db'
import { createEdge, deleteEdge, getEdgesForThought, type Edge } from '../db/edges'
import { getThoughtRow, type Thought } from '../db/thoughts'
import {
  deleteThoughtUrlLinksNotIn,
  getThoughtUrlLinksForThoughts,
  upsertThoughtUrlLink
} from '../db/thought_url_links'
import { insertLog } from '../logging/log'
import { EdgeAlreadyExistsError, ValidationError } from '../errors'

export function validateMergePreconditions(source: Thought, allowArchivedSource = false): void {
  if (source.status === 'archived' && !allowArchivedSource) {
    throw new ValidationError('Source thought is already archived')
  }
}

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

export function transferEdgesFromSource(
  sourceId: string,
  targetId: string,
  d: Database = getDb()
): number {
  const edgesToTransfer = getEdgesForThought(d, sourceId)
  let transferredEdges = 0

  for (const edge of edgesToTransfer) {
    const isClusterEdge = edge.type === 'cluster'
    const newSourceId = edge.source_id === sourceId ? targetId : edge.source_id
    const newTargetId = edge.target_id === sourceId ? targetId : edge.target_id

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
    } else if (isClusterEdge) {
      const srcRow = getThoughtRow(d, newSourceId)
      const tgtRow = srcRow?.is_cluster ? getThoughtRow(d, newTargetId) : undefined
      if (srcRow?.is_cluster && !tgtRow?.is_cluster) {
        if (
          tryCreateRemappedEdge(d, newSourceId, newTargetId, edge.type, edge, targetId, sourceId)
        ) {
          transferredEdges++
        }
      }
    } else {
      if (tryCreateRemappedEdge(d, newSourceId, newTargetId, edge.type, edge, targetId, sourceId)) {
        transferredEdges++
      }
    }

    deleteEdge(d, edge.id)
  }

  return transferredEdges
}

export function transferUrlLinksFromSource(
  sourceId: string,
  targetId: string,
  d: Database = getDb()
): number {
  const sourceLinks = getThoughtUrlLinksForThoughts(d, [sourceId])
  if (sourceLinks.length === 0) return 0

  const targetLinks = getThoughtUrlLinksForThoughts(d, [targetId])
  const targetUrlByKey = new Map(targetLinks.map(link => [link.key, link.url]))
  let nextSortOrder = targetLinks.reduce((max, link) => Math.max(max, link.sort_order), -1) + 1
  let transferred = 0

  for (const link of sourceLinks) {
    const targetUrl = targetUrlByKey.get(link.key)
    if (targetUrl !== undefined) {
      insertLog(
        'warning',
        'thought',
        `Merge: url link '${link.key}' already on target ${targetId} (${targetUrl}) — source url ${link.url} dropped`,
        {
          target_id: targetId,
          source_id: sourceId,
          link_key: link.key,
          kept_url: targetUrl,
          dropped_url: link.url
        }
      )
      continue
    }
    upsertThoughtUrlLink(d, targetId, link.key, link.url, link.label, nextSortOrder)
    nextSortOrder++
    transferred++
  }

  deleteThoughtUrlLinksNotIn(d, sourceId, [])

  return transferred
}
