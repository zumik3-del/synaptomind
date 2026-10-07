import type { Database } from 'bun:sqlite'
import { getDb } from '../db'
import type { CreateThoughtInput, Thought } from '../db/thoughts'
import { type ThoughtUrlLink, deleteThoughtUrlLink, getThoughtUrlLinks, getThoughtUrlLinksForThoughts, upsertThoughtUrlLink } from '../db/thought_url_links'
import { NotFoundError, ValidationError } from '../errors'
import { createThoughtWithParent } from './thoughts.service'

export function listThoughtUrlLinksService(thoughtId: string, d: Database = getDb()): ThoughtUrlLink[] {
  return getThoughtUrlLinks(d, thoughtId)
}

interface ThoughtUrlLinksBatch {
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

interface UpsertUrlLinkInput {
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

export interface UrlLink {
  text: string
  url: string
}

export function createThoughtWithUrlLinks(
  data: CreateThoughtInput,
  options?: { parentId?: string; relation?: string; urlLinks?: UrlLink[] },
  d: Database = getDb()
): Thought {
  const run = d.transaction(() => {
    const thought = createThoughtWithParent(data, options?.parentId, options?.relation, d)
    if (options?.urlLinks && options.urlLinks.length > 0) {
      for (const link of options.urlLinks) {
        upsertThoughtUrlLink(d, thought.id, link.text, link.url, link.text, 0)
      }
    }
    return thought
  })
  return run()
}
