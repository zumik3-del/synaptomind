import { createEdge, deleteEdge } from '../db/edges'
import { getDb } from '../db'
import { ValidationError } from '../errors'
import type { Database } from 'bun:sqlite'

export function createEdgeService(sourceId: string, targetId: string, type?: string, d: Database = getDb()) {
  if (!targetId) {
    throw new ValidationError('target_id is required')
  }
  return createEdge(d, sourceId, targetId, type)
}

export function deleteEdgeService(id: string, d: Database = getDb()): boolean {
  return deleteEdge(d, id)
}
