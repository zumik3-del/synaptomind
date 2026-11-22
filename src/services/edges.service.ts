import {
  deleteEdge,
  findEdge,
  getEdgePairBetween,
  insertEdgeRow,
  replaceEdgeRow,
  validateRetype,
  EDGE_TYPES,
  EdgeAlreadyExistsError,
  ClusterEdgeValidationError,
  EdgeConflictError,
  InvalidEdgeTypeError,
  SelfLoopEdgeError,
  SYMMETRIC_EDGE_TYPES,
  isValidEdgeType,
  validateClusterConstraint,
  type Edge
} from '../db/edges'
import { boostImportance } from '../db/importance'
import { getDb } from '../db'
import { NotFoundError, ValidationError } from '../errors'
import { BATCH_ITEMS_MAX } from '../validation'
import type { Database } from 'bun:sqlite'

export { EDGE_TYPES, type EdgeType, type EdgeView } from '../db/edges'

export function createEdge(
  d: Database,
  sourceId: string,
  targetId: string,
  type: string = 'related'
): Edge {
  if (!isValidEdgeType(type)) {
    throw new InvalidEdgeTypeError(type, [...EDGE_TYPES])
  }
  if (type === 'child') {
    throw new ClusterEdgeValidationError(
      "Edge type 'child' is deprecated. Use 'parent' instead — 'parent' covers both directions."
    )
  }
  if (sourceId === targetId) {
    throw new SelfLoopEdgeError()
  }
  validateClusterConstraint(d, sourceId, targetId, type)

  const existing = getEdgePairBetween(d, sourceId, targetId)
  if (existing) {
    if (existing.type === type) {
      if (SYMMETRIC_EDGE_TYPES.has(type)) return existing
      if (existing.source_id === sourceId && existing.target_id === targetId) {
        throw new EdgeAlreadyExistsError()
      }
      throw new EdgeConflictError(sourceId, targetId)
    }
    if (existing.type === 'related') {
      return upgradePlaceholderEdge(d, existing, sourceId, targetId, type)
    }
    throw new EdgeConflictError(sourceId, targetId)
  }

  return insertEdge(d, sourceId, targetId, type)
}

function insertEdge(d: Database, sourceId: string, targetId: string, type: string): Edge {
  let id = ''
  let inserted = false
  const insertInTx = d.transaction(() => {
    const row = insertEdgeRow(d, sourceId, targetId, type)
    id = row.id
    inserted = row.inserted
    if (inserted) boostImportance(d, sourceId, 0.1)
  })
  insertInTx()

  if (!inserted) {
    const existing = getEdgePairBetween(d, sourceId, targetId)
    if (existing) return existing
    throw new EdgeAlreadyExistsError()
  }

  return findEdge(d, id)
}

function upgradePlaceholderEdge(
  d: Database,
  placeholder: Edge,
  sourceId: string,
  targetId: string,
  type: string
): Edge {
  let id = ''
  const replaceInTx = d.transaction(() => {
    id = replaceEdgeRow(d, placeholder.id, sourceId, targetId, type, new Date().toISOString())
    boostImportance(d, sourceId, 0.1)
  })
  replaceInTx()

  return findEdge(d, id)
}

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

  const linkItem = d.transaction((link: LinkBatchItem) => {
    if (!link?.source) throw new ValidationError('source is required')
    if (!link.target) throw new ValidationError('target is required')
    createEdgeService(link.source, link.target, link.type, d)
  })
  // One run-level transaction, a savepoint per link: the savepoint is the isolation contract.
  const runLinks = d.transaction(() => {
    links.forEach((link, index) => {
      try {
        linkItem(link)
        linked++
      } catch (err) {
        // A trigger can RAISE(ROLLBACK) the whole run; continuing would autocommit the rest.
        if (!d.inTransaction) throw err
        errors.push({
          index,
          source: link?.source,
          target: link?.target,
          error: err instanceof Error ? err.message : String(err)
        })
      }
    })
  })
  runLinks()

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
  const results: UnlinkBatchItemResult[] = []
  const errors: UnlinkBatchError[] = []

  const recordFailure = (index: number, id: string, error: string) => {
    results.push({ edge_id: id, status: 'failed', error })
    errors.push({ index, edge_id: id, error })
  }

  const outcome = (): UnlinkBatchResult => {
    const result: UnlinkBatchResult = {
      deleted,
      preview,
      failed: errors.length,
      unlinked: deleted,
      previews: preview,
      failures: errors.length,
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

  if (!confirm) {
    edgeIds.forEach((id, index) => {
      const edge = findEdge(d, id)
      if (!edge) {
        recordFailure(index, id, `Edge not found: ${id}`)
        return
      }
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
    })
    return outcome()
  }

  // All-or-nothing: a refusal is decided before the transaction opens, so it writes nothing.
  if (edgeIds.some(id => !findEdge(d, id))) {
    edgeIds.forEach((id, index) => {
      const edge = findEdge(d, id)
      if (!edge) recordFailure(index, id, `Edge not found: ${id}`)
      else recordFailure(index, id, 'batch aborted: not all edge_ids exist (no edges deleted)')
    })
    return outcome()
  }
  if (new Set(edgeIds).size !== edgeIds.length) {
    edgeIds.forEach((id, index) => {
      recordFailure(index, id, 'batch aborted: duplicate edge_ids (no edges deleted)')
    })
    return outcome()
  }

  const removeAll = d.transaction(() => {
    for (const id of edgeIds) {
      if (!deleteEdge(d, id)) throw new NotFoundError(`Edge not found: ${id}`)
      deleted++
      results.push({ edge_id: id, status: 'deleted' })
    }
  })
  removeAll()

  return outcome()
}

export function validateRetypeService(
  edgeId: string,
  newType: string,
  d: Database = getDb()
): Edge {
  // Read-only retype validation: the preview needs the current edge and must refuse an invalid
  // type before it issues a token, so this path never writes.
  const edge = findEdge(d, edgeId)
  if (!edge) {
    throw new NotFoundError(`Edge not found: ${edgeId}`)
  }
  validateRetype(d, edge, newType)
  return edge
}
