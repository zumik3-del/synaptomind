import type { Database } from 'bun:sqlite'
import { getDb } from '../db'
import type { Thought } from '../db/thoughts'
import type { ThoughtStatus } from '../types/thought'
import { ValidationError } from '../errors'
import { createThoughtWithParent } from './thoughts.service'

export interface BulkCreateItem {
  content: string
  status?: ThoughtStatus
  tags?: string[]
  source?: string
  project_id?: string
  parent_id?: string
  relation?: string
  is_profile?: boolean
  is_protected?: boolean
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
  if (items.length > 10000) {
    throw new ValidationError('Maximum 10000 thoughts per bulk request')
  }

  const created: BulkCreateResult['created'] = []
  const errors: BulkCreateResult['errors'] = []

  const run = d.transaction(() => {
    for (let i = 0; i < items.length; i++) {
      const t = items[i]
      try {
        const thought = createThoughtWithParent(
          {
            content: t.content,
            status: t.status,
            tags: t.tags,
            source: t.source,
            project_id: t.project_id ?? defaultProjectId,
            is_profile: t.is_profile,
            is_protected: t.is_protected
          },
          t.parent_id,
          t.relation,
          d
        )
        created.push({ index: i, thought })
      } catch (err) {
        errors.push({ index: i, error: err instanceof Error ? err.message : String(err) })
      }
    }
  })
  run()

  return { created, errors }
}
