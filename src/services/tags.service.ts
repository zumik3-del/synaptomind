import { deleteTag, listTags, pruneOrphanTags, renameTag } from '../db/tags'
import { getDb } from '../db'
import { ValidationError } from './errors'

export function listTagsService(q?: string) {
  return listTags(getDb(), q)
}

export function renameTagService(id: string, newName: string) {
  if (!newName?.trim()) {
    throw new ValidationError('name is required')
  }
  return renameTag(getDb(), id, newName.trim()) ?? null
}

export function deleteTagService(id: string): boolean {
  const db = getDb()
  const deleted = deleteTag(db, id)
  if (deleted) {
    pruneOrphanTags(db)
  }
  return deleted
}
