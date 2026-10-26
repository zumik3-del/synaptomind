import type { Database } from 'bun:sqlite'
import { getDb } from '../db'
import type { CreateThoughtInput, Thought } from '../db/thoughts'
import { type ThoughtUrlLink, getThoughtUrlLinksForThoughts, upsertThoughtUrlLink } from '../db/thought_url_links'
import { createThoughtWithParentService } from './thoughts.service'

interface ThoughtUrlLinksBatch {
  [thoughtId: string]: ThoughtUrlLink[]
}

/**
 * Url links of many thoughts in one query, keyed by thought id.
 *
 * Page-level helper for the MCP read surface (`include_url_links`, ADR §4 of the
 * 0.20 HTTP shrink): a caller passes every thought id a response emits, so the
 * cost stays one query per response instead of one per thought. A thought
 * without links has no entry.
 */
export function getThoughtUrlLinksBatchService(thoughtIds: readonly string[], d: Database = getDb()): ThoughtUrlLinksBatch {
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
    if (options?.urlLinks && options.urlLinks.length > 0) {
      for (const link of options.urlLinks) {
        upsertThoughtUrlLink(d, thought.id, link.text, link.url, link.text, 0)
      }
    }
    return thought
  })
  return run()
}
