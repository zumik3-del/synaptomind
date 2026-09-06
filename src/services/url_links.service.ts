import type { Database } from 'bun:sqlite'
import { getDb } from '../db'
import { type ThoughtUrlLink, deleteThoughtUrlLink, getThoughtUrlLinks, getThoughtUrlLinksForThoughts, upsertThoughtUrlLink } from '../db/thought_url_links'
import { NotFoundError, ValidationError } from '../errors'

export function listThoughtUrlLinksService(thoughtId: string, d: Database = getDb()): ThoughtUrlLink[] {
  return getThoughtUrlLinks(d, thoughtId)
}

export interface ThoughtUrlLinksBatch {
  [thoughtId: string]: ThoughtUrlLink[]
}

export function getThoughtUrlLinksBatchService(rawIds: string | undefined, d: Database = getDb()): ThoughtUrlLinksBatch {
  if (!rawIds) throw new ValidationError('ids query parameter is required')
  const ids = [...new Set(rawIds.split(',').map(s => s.trim()).filter(Boolean))].slice(0, 200)
  const map: ThoughtUrlLinksBatch = {}
  for (const row of getThoughtUrlLinksForThoughts(d, ids)) {
    if (!map[row.thought_id]) map[row.thought_id] = []
    map[row.thought_id].push(row)
  }
  return map
}

export interface UpsertUrlLinkInput {
  key: string
  url: string
  label?: string
  sort_order?: number
}

export function upsertThoughtUrlLinkService(thoughtId: string, input: UpsertUrlLinkInput, d: Database = getDb()): ThoughtUrlLink {
  if (!input.key || !input.url) throw new ValidationError('key and url are required')
  const key = input.key.trim()
  return upsertThoughtUrlLink(d, thoughtId, key, input.url, (input.label ?? key).trim(), input.sort_order ?? 0)
}

export function deleteThoughtUrlLinkService(thoughtId: string, key: string, d: Database = getDb()): void {
  const ok = deleteThoughtUrlLink(d, thoughtId, key)
  if (!ok) throw new NotFoundError()
}
