import { deleteTag, listTags, pruneOrphanTags, renameTag } from '../db/tags'
import { getDb } from '../db'
import { ValidationError } from '../errors'
import type { Database } from 'bun:sqlite'

export function listTagsService(q?: string, d: Database = getDb()) {
  return listTags(d, q)
}

export function renameTagService(id: string, newName: string, d: Database = getDb()) {
  if (!newName?.trim()) {
    throw new ValidationError('name is required')
  }
  return renameTag(d, id, newName.trim()) ?? null
}

export function deleteTagService(id: string, d: Database = getDb()): boolean {
  const deleted = deleteTag(d, id)
  if (deleted) {
    pruneOrphanTags(d)
  }
  return deleted
}
