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
interface LinkBatchError {
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

/** One `unlink_batch` item result (task #1972). */
interface UnlinkBatchItemResult {
  edge_id: string
  status: 'deleted' | 'preview' | 'failed'
  /** Present on `preview` results (mirrors single `unlink`). */
  edge?: { id: string; source_id: string; target_id: string; type: string; created_at: string }
  consequence?: string
  error?: string
}

/** One `unlink_batch` failure entry (task #1972). */
interface UnlinkBatchError {
  index: number
  edge_id?: string
  error: string
}

/** Outcome of `deleteEdgesBatchService` (task #1972): counts plus per-edge status. */
export interface UnlinkBatchResult {
  /** Edges actually deleted (confirm mode, all ids valid). */
  deleted: number
  /** Edges shown as a non-mutating preview (preview mode). */
  preview: number
  /** Edges that could not be processed. */
  failed: number
  /** Alias for `deleted`. */
  unlinked: number
  /** Alias for `preview`. */
  previews: number
  /** Alias for `failed`. */
  failures: number
  total: number
  /** Per-edge status (primary). */
  results: UnlinkBatchItemResult[]
  /** Alias for `results`. */
  items: UnlinkBatchItemResult[]
  /** Alias for `results`. */
  edges: UnlinkBatchItemResult[]
  errors: UnlinkBatchError[]
  instruction?: string
}

/**
 * Delete (or preview) several edges in one call (task #1972).
 *
 * Runs in ONE transaction. In confirm mode every `edge_id` is validated to exist
 * BEFORE any deletion happens, so a missing id aborts the whole batch instead
 * of leaving a partial prune behind. Preview mode (confirm=false) never mutates
 * and reports per-edge preview details.
 */
export function deleteEdgesBatchService(
  edgeIds: string[],
  confirm: boolean = false,
  d: Database = getDb()
): UnlinkBatchResult {
  if (!Array.isArray(edgeIds) || edgeIds.length === 0) {
    throw new ValidationError('edge_ids is required and must not be empty')
  }
  if (edgeIds.length > BATCH_ITEMS_MAX) {
    throw new ValidationError(`edge_ids accepts at most ${BATCH_ITEMS_MAX} items per call (got ${edgeIds.length})`)
  }

  let deleted = 0
  let preview = 0
  let failed = 0
  const results: UnlinkBatchItemResult[] = []
  const errors: UnlinkBatchError[] = []

  const run = d.transaction(() => {
    // Transactional validation (confirm mode only): every id must resolve before
    // we touch a single row.
    if (confirm) {
      const anyMissing = edgeIds.some((id) => !findEdge(d, id))
      if (anyMissing) {
        edgeIds.forEach((id, index) => {
          const edge = findEdge(d, id)
          if (!edge) {
            failed++
            const err = `Edge not found: ${id}`
            results.push({ edge_id: id, status: 'failed', error: err })
            errors.push({ index, edge_id: id, error: err })
          } else {
            failed++
            const err = 'batch aborted: not all edge_ids exist'
            results.push({ edge_id: id, status: 'failed', error: err })
            errors.push({ index, edge_id: id, error: err })
          }
        })
        return
      }
    }

    edgeIds.forEach((id, index) => {
      const edge = findEdge(d, id)
      if (!edge) {
        failed++
        const err = `Edge not found: ${id}`
        results.push({ edge_id: id, status: 'failed', error: err })
        errors.push({ index, edge_id: id, error: err })
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
        failed++
        const err = `Edge not found: ${id}`
        results.push({ edge_id: id, status: 'failed', error: err })
        errors.push({ index, edge_id: id, error: err })
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
    result.instruction = 'Call memory_store again with action=unlink_batch, edge_ids=[...], confirm=true to proceed.'
  }
  return result
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
