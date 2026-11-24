import type { Database } from 'bun:sqlite'
import { getDb } from '../db'
import type { Thought } from '../db/thoughts'
import type { ThoughtStatus } from '../types/thought'
import { ValidationError } from '../errors'
import { runTolerantBatch } from './batch-run.service'
import { createThoughtWithUrlLinksService, type UrlLink } from './url_links.service'

export const BULK_ITEMS_MAX = 10000

export interface BulkCreateItem {
  content: string
  status?: ThoughtStatus
  tags?: string[]
  source?: string
  project_id?: string
  parent_id?: string
  relation?: string
  is_protected?: boolean
  is_global?: boolean
  url_links?: UrlLink[]
}

interface BulkCreateResult {
  created: Array<{ index: number; thought: Thought }>
  errors: Array<{ index: number; error: string }>
}

export function bulkCreateThoughtsService(
  items: BulkCreateItem[] | undefined,
  defaultProjectId?: string,
  d: Database = getDb()
): BulkCreateResult {
  if (!Array.isArray(items) || items.length === 0) {
    throw new ValidationError('thoughts array is required and must not be empty')
  }
  if (items.length > BULK_ITEMS_MAX) {
    throw new ValidationError(`Maximum ${BULK_ITEMS_MAX} thoughts per bulk request`)
  }

  const { results: created, errors } = runTolerantBatch(
    d,
    items,
    (t, index, db) => ({
      index,
      thought: createThoughtWithUrlLinksService(
        {
          content: t.content,
          status: t.status,
          tags: t.tags,
          source: t.source,
          project_id: t.project_id ?? defaultProjectId,
          is_protected: t.is_protected,
          is_global: t.is_global
        },
        { parentId: t.parent_id, relation: t.relation, urlLinks: t.url_links },
        db
      )
    }),
    ({ index, message }) => ({ index, error: message })
  )

  return { created, errors }
}
