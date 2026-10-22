import { createEdge, deleteEdge, findEdge, retypeEdge, validateRetype, type Edge } from '../db/edges'
import { getDb } from '../db'
import { NotFoundError, ValidationError } from '../errors'
import { BATCH_ITEMS_MAX } from '../validation'
import type { Database } from 'bun:sqlite'

// Re-export the canonical edge-type list so the MCP layer (store.ts) derives its
// zod enums from the db-layer source of truth without importing db directly
// (AGENTS.md §4 layering: api/mcp -> services -> db).
export { EDGE_TYPES, type EdgeType } from '../db/edges'

export function createEdgeService(sourceId: string, targetId: string, type?: string, d: Database = getDb()) {
  if (!targetId) {
    throw new ValidationError('target_id is required')
  }
  return createEdge(d, sourceId, targetId, type)
}

/** One `link_batch` item: the edge to create (task #1964). */
export interface LinkBatchItem {
  source: string
  target: string
  /** Edge type; defaults to `related` like the single `link` action. */
  type?: string
}

/** One `link_batch` item that could not be linked, with its position and reason. */
export interface LinkBatchError {
  index: number
  source?: string
  target?: string
  error: string
}

/** Outcome of `createEdgesBatchService` (task #1964): counts plus per-item failures. */
export interface LinkBatchResult {
  /** Edges the writer accepted — an idempotent replay of a symmetric edge counts too. */
  linked: number
  /** Always `errors.length`, so a caller sees the failure count without scanning. */
  failed: number
  errors: LinkBatchError[]
}

/**
 * Create several edges in one call (task #1964).
 *
 * Reuses `createEdgeService`, so every single-link rule (type vocabulary, no self
 * loops, one type per pair, cluster strictness, the `related` upgrade) applies
 * item by item. The batch runs in ONE transaction and reports per-item failures
 * instead of aborting the rest — the contract `bulkCreateThoughtsService` already
 * uses: a failure is collected, the items that succeeded still commit, and
 * nothing is swallowed silently.
 */
export function createEdgesBatchService(links: LinkBatchItem[], d: Database = getDb()): LinkBatchResult {
  if (!Array.isArray(links) || links.length === 0) {
    throw new ValidationError('links is required and must not be empty')
  }
  if (links.length > BATCH_ITEMS_MAX) {
    throw new ValidationError(`links accepts at most ${BATCH_ITEMS_MAX} items per call (got ${links.length})`)
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

export function deleteEdgeService(id: string, d: Database = getDb()): boolean {
  return deleteEdge(d, id)
}

export function findEdgeService(id: string, d: Database = getDb()): Edge | undefined {
  return findEdge(d, id)
}

export function retypeEdgeService(edgeId: string, newType: string, d: Database = getDb()): Edge {
  return retypeEdge(d, edgeId, newType)
}

/**
 * Dry-run counterpart of retypeEdgeService: resolves the edge and runs the
 * SAME validation as the confirm path (isValidEdgeType, same-type,
 * validateClusterConstraint) without mutating. Returns the edge so the
 * caller can build the preview.
 */
export function validateRetypeService(edgeId: string, newType: string, d: Database = getDb()): Edge {
  const edge = findEdge(d, edgeId)
  if (!edge) {
    throw new NotFoundError(`Edge not found: ${edgeId}`)
  }
  validateRetype(d, edge, newType)
  return edge
}
