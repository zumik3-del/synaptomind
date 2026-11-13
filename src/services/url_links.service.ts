import type { Database } from 'bun:sqlite'
import { getDb } from '../db'
import type { CreateThoughtInput, Thought } from '../db/thoughts'
import {
  type ThoughtUrlLink,
  getThoughtUrlLinksForThoughts,
  upsertThoughtUrlLink
} from '../db/thought_url_links'
import { createThoughtWithParentService } from './thoughts.service'

interface ThoughtUrlLinksBatch {
  [thoughtId: string]: ThoughtUrlLink[]
}

export function getThoughtUrlLinksBatchService(
  thoughtIds: readonly string[],
  d: Database = getDb()
): ThoughtUrlLinksBatch {
  const unique = [...new Set(thoughtIds.filter(id => typeof id === 'string' && id.length > 0))]
  const map: ThoughtUrlLinksBatch = {}
  for (const row of getThoughtUrlLinksForThoughts(d, unique)) {
    if (!map[row.thought_id]) map[row.thought_id] = []
    map[row.thought_id].push(row)
  }
  return map
}

export interface UrlLink {
  text: string
  url: string
}

export function createThoughtWithUrlLinksService(
  data: CreateThoughtInput,
  options?: { parentId?: string; relation?: string; urlLinks?: UrlLink[] },
  d: Database = getDb()
): Thought {
  const run = d.transaction(() => {
    const thought = createThoughtWithParentService(data, options?.parentId, options?.relation, d)
    options?.urlLinks?.forEach((link, index) => {
      upsertThoughtUrlLink(d, thought.id, link.text, link.url, link.text, index)
    })
    return thought
  })
  return run()
}
