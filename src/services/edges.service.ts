import { createEdge, deleteEdge, getAllActiveEdges, getEdgesForThought } from '../db/edges'
import { getDb } from '../db'
import { ValidationError } from './errors'

export function createEdgeService(sourceId: string, targetId: string, type?: string) {
  if (!targetId) {
    throw new ValidationError('target_id is required')
  }
  return createEdge(getDb(), sourceId, targetId, type)
}

export function deleteEdgeService(id: string): boolean {
  return deleteEdge(getDb(), id)
}

export function getEdgesForThoughtService(id: string) {
  return getEdgesForThought(getDb(), id)
}

export function getAllActiveEdgesService() {
  return getAllActiveEdges(getDb())
}
