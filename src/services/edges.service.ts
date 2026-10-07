import { createEdge, deleteEdge, findEdge, retypeEdge, validateRetype, type Edge } from '../db/edges'
import { getDb } from '../db'
import { NotFoundError, ValidationError } from '../errors'
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
