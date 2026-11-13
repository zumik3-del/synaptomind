import {
  createEdge,
  deleteEdge,
  findEdge,
  retypeEdge,
  validateRetype,
  type Edge
} from '../db/edges'
import { getDb } from '../db'
import { NotFoundError, ValidationError } from '../errors'
import { BATCH_ITEMS_MAX } from '../validation'
import type { Database } from 'bun:sqlite'

export { EDGE_TYPES, type EdgeType, type EdgeView } from '../db/edges'

export function createEdgeService(
  sourceId: string,
  targetId: string,
  type?: string,
  d: Database = getDb()
) {
  if (!targetId) {
    throw new ValidationError('target_id is required')
  }
  return createEdge(d, sourceId, targetId, type)
}

export interface LinkBatchItem {
  source: string
  target: string
  type?: string
}

interface LinkBatchError {
  index: number
  source?: string
  target?: string
  error: string
}

export interface LinkBatchResult {
  linked: number
  failed: number
  errors: LinkBatchError[]
}

export function createEdgesBatchService(
  links: LinkBatchItem[],
  d: Database = getDb()
): LinkBatchResult {
  if (!Array.isArray(links) || links.length === 0) {
    throw new ValidationError('links is required and must not be empty')
  }
  if (links.length > BATCH_ITEMS_MAX) {
    throw new ValidationError(
      `links accepts at most ${BATCH_ITEMS_MAX} items per call (got ${links.length})`
    )
  }

  let linked = 0
  const errors: LinkBatchError[] = []

  const run = d.transaction(() => {
    links.forEach((link, index) => {
      try {
        if (!link?.source) throw new ValidationError('source is required')
        if (!link.target) throw new ValidationError('target is required')
        createEdgeService(link.source, link.target, link.type, d)
        linked++
      } catch (err) {
        errors.push({
          index,
          source: link?.source,
          target: link?.target,
          error: err instanceof Error ? err.message : String(err)
        })
      }
    })
  })
  run()

  return { linked, failed: errors.length, errors }
}

export function deleteEdgeService(edgeId: string, d: Database = getDb()): boolean {
  return deleteEdge(d, edgeId)
}

interface UnlinkBatchItemResult {
  edge_id: string
  status: 'deleted' | 'preview' | 'failed'
  edge?: { id: string; source_id: string; target_id: string; type: string; created_at: string }
  consequence?: string
  error?: string
}

interface UnlinkBatchError {
  index: number
  edge_id?: string
  error: string
}

export interface UnlinkBatchResult {
  deleted: number
  preview: number
  failed: number
  unlinked: number
  previews: number
  failures: number
  total: number
  results: UnlinkBatchItemResult[]
  items: UnlinkBatchItemResult[]
  edges: UnlinkBatchItemResult[]
  errors: UnlinkBatchError[]
  instruction?: string
}

export function deleteEdgesBatchService(
  edgeIds: string[],
  confirm: boolean = false,
  d: Database = getDb()
): UnlinkBatchResult {
  if (!Array.isArray(edgeIds) || edgeIds.length === 0) {
    throw new ValidationError('edge_ids is required and must not be empty')
  }
  if (edgeIds.length > BATCH_ITEMS_MAX) {
    throw new ValidationError(
      `edge_ids accepts at most ${BATCH_ITEMS_MAX} items per call (got ${edgeIds.length})`
    )
  }

  let deleted = 0
  let preview = 0
  let failed = 0
  const results: UnlinkBatchItemResult[] = []
  const errors: UnlinkBatchError[] = []

  const recordFailure = (index: number, id: string, error: string) => {
    failed++
    results.push({ edge_id: id, status: 'failed', error })
    errors.push({ index, edge_id: id, error })
  }

  const run = d.transaction(() => {
    if (confirm) {
      const anyMissing = edgeIds.some(id => !findEdge(d, id))
      if (anyMissing) {
        edgeIds.forEach((id, index) => {
          const edge = findEdge(d, id)
          if (!edge) {
            recordFailure(index, id, `Edge not found: ${id}`)
          } else {
            recordFailure(
              index,
              id,
              'batch aborted: not all edge_ids exist (transaction rolled back)'
            )
          }
        })
        return
      }
      if (new Set(edgeIds).size !== edgeIds.length) {
        edgeIds.forEach((id, index) => {
          recordFailure(index, id, 'batch aborted: duplicate edge_ids (no edges deleted)')
        })
        return
      }
    }

    edgeIds.forEach((id, index) => {
      const edge = findEdge(d, id)
      if (!edge) {
        recordFailure(index, id, `Edge not found: ${id}`)
        return
      }
      if (!confirm) {
        preview++
        results.push({
          edge_id: id,
          status: 'preview',
          edge: {
            id: edge.id,
            source_id: edge.source_id,
            target_id: edge.target_id,
            type: edge.type,
            created_at: edge.created_at
          },
          consequence: `Removes the '${edge.type}' edge between '${edge.source_id}' and '${edge.target_id}'.`
        })
        return
      }
      const ok = deleteEdge(d, id)
      if (ok) {
        deleted++
        results.push({ edge_id: id, status: 'deleted' })
      } else {
        recordFailure(index, id, `Edge not found: ${id}`)
      }
    })
  })
  run()

  const result: UnlinkBatchResult = {
    deleted,
    preview,
    failed,
    unlinked: deleted,
    previews: preview,
    failures: failed,
    total: edgeIds.length,
    results,
    items: results,
    edges: results,
    errors
  }
  if (preview > 0 && !confirm) {
    result.instruction =
      'Call memory_store again with action=unlink_batch, edge_ids=[...], confirm=true to proceed.'
  }
  return result
}

export function findEdgeService(edgeId: string, d: Database = getDb()): Edge | undefined {
  return findEdge(d, edgeId)
}

export function retypeEdgeService(edgeId: string, newType: string, d: Database = getDb()): Edge {
  return retypeEdge(d, edgeId, newType)
}

export function validateRetypeService(
  edgeId: string,
  newType: string,
  d: Database = getDb()
): Edge {
  const edge = findEdge(d, edgeId)
  if (!edge) {
    throw new NotFoundError(`Edge not found: ${edgeId}`)
  }
  validateRetype(d, edge, newType)
  return edge
}
