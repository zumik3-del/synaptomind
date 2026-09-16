import { createEdge, deleteEdge } from '../db/edges'
import { getDb } from '../db'
import { ValidationError } from '../errors'

export function createEdgeService(sourceId: string, targetId: string, type?: string) {
  if (!targetId) {
    throw new ValidationError('target_id is required')
  }
  return createEdge(getDb(), sourceId, targetId, type)
}

export function deleteEdgeService(id: string): boolean {
  return deleteEdge(getDb(), id)
}
