import type { Database } from 'bun:sqlite'
import { getDb } from '../db'
import type { Thought } from '../db/thoughts'
import type { ThoughtStatus } from '../types/thought'
import { ValidationError } from '../errors'
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

  const created: BulkCreateResult['created'] = []
  const errors: BulkCreateResult['errors'] = []

  const createItem = d.transaction((t: BulkCreateItem) =>
    createThoughtWithUrlLinksService(
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
      d
    )
  )
  // One run-level transaction, a savepoint per item: the savepoint is the isolation contract.
  const runBulk = d.transaction(() => {
    for (let i = 0; i < items.length; i++) {
      try {
        created.push({ index: i, thought: createItem(items[i]) })
      } catch (err) {
        // A trigger can RAISE(ROLLBACK) the whole run; continuing would autocommit the rest.
        if (!d.inTransaction) throw err
        errors.push({ index: i, error: err instanceof Error ? err.message : String(err) })
      }
    }
  })
  runBulk()

  return { created, errors }
}
