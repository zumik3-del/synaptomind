import type { Database } from 'bun:sqlite'
export type { Thought } from '../db/thoughts'
import { type Config, config } from '../config'
import { createEdge } from './edges.service'
import { getDb } from '../db'
import { getThoughtLimitsDB } from '../config.thought-limits'
import { deleteThoughtUrlLinksNotIn, upsertThoughtUrlLink } from '../db/thought_url_links'
import type { UrlLink } from './url_links.service'
import {
  type CreateThoughtInput,
  archiveThought as dbArchiveThought,
  countThoughts,
  createThought as dbCreateThought,
  getThought as dbGetThought,
  listThoughts as dbListThoughts,
  updateThought as dbUpdateThought,
  type ListThoughtsOptions,
  type Thought,
  type UpdateThoughtInput,
  THOUGHTS_PAGE_LIMIT_DEFAULT
} from '../db/thoughts'
import { insertLog } from '../logging/log'
import {
  validateContentLength,
  validateStatus,
  BATCH_ITEMS_MAX,
  isoDateTimeSchema
} from '../validation'
import { EdgeAlreadyExistsError, NotFoundError, ValidationError } from '../errors'
import { runTolerantBatch } from './batch-run.service'

export function getThoughtByIdService(id: string, d: Database = getDb()): Thought | null {
  return dbGetThought(d, id) ?? null
}

export function createThoughtWithParentService(
  data: CreateThoughtInput,
  parentId?: string,
  relation?: string,
  d: Database = getDb(),
  cfg: Config = config
): Thought {
  validateStatus(data.status)
  validateContentLength(data.content, getThoughtLimitsDB(cfg))
  const create = d.transaction(() => {
    const thought = dbCreateThought(d, data)
    if (parentId) {
      try {
        createEdge(d, parentId, thought.id, relation ?? 'parent')
      } catch (err) {
        if (!(err instanceof EdgeAlreadyExistsError)) throw err
        insertLog(
          'warning',
          'thought',
          `Parent edge ${relation ?? 'parent'} already exists between ${parentId} and ${thought.id} — skipped`,
          {
            parent_id: parentId,
            thought_id: thought.id,
            relation: relation ?? 'parent'
          }
        )
      }
    }
    return thought
  })
  const thought = create()
  return { ...thought, content_language: cfg.contentLanguage }
}

interface UpdateThoughtOptions {
  urlLinks?: UrlLink[]
}

function writeUrlLinks(id: string, urlLinks: UrlLink[], d: Database): void {
  urlLinks.forEach((link, index) => {
    upsertThoughtUrlLink(d, id, link.text, link.url, link.text, index)
  })
  deleteThoughtUrlLinksNotIn(
    d,
    id,
    urlLinks.map(link => link.text)
  )
}

// Options ride before `d`: url links are not a column, and `UpdateThoughtInput` whitelists columns.
export function updateThoughtByIdService(
  id: string,
  data: UpdateThoughtInput,
  options: UpdateThoughtOptions = {},
  d: Database = getDb(),
  cfg: Config = config
): Thought | null {
  validateStatus(data.status)
  if (data.content !== undefined) {
    validateContentLength(data.content, getThoughtLimitsDB(cfg), id)
  }
  if (data.surface_after !== undefined && data.surface_after !== null) {
    if (
      typeof data.surface_after !== 'string' ||
      !isoDateTimeSchema.safeParse(data.surface_after).success
    ) {
      throw new ValidationError(
        `Invalid surface_after: ${String(data.surface_after)}. Must be a valid ISO timestamp or null.`
      )
    }
  }
  const run = d.transaction(() => {
    const updated = dbUpdateThought(d, id, data)
    if (updated && options.urlLinks !== undefined) writeUrlLinks(id, options.urlLinks, d)
    return updated
  })
  const updated = run()
  if (!updated) return null
  return { ...updated, content_language: cfg.contentLanguage }
}

export function archiveThoughtByIdService(id: string, d: Database = getDb()): Thought | null {
  const thought = dbGetThought(d, id)
  if (!thought) return null
  return dbArchiveThought(d, id) ?? null
}

interface ArchiveBatchError {
  thought_id: string
  error: string
}

interface ArchiveBatchResult {
  archived: number
  failed: number
  errors: ArchiveBatchError[]
}

export function archiveThoughtsBatchService(
  ids: string[],
  d: Database = getDb()
): ArchiveBatchResult {
  if (!Array.isArray(ids) || ids.length === 0) {
    throw new ValidationError('thought_ids is required and must not be empty')
  }
  if (ids.length > BATCH_ITEMS_MAX) {
    throw new ValidationError(
      `thought_ids accepts at most ${BATCH_ITEMS_MAX} ids per call (got ${ids.length})`
    )
  }

  const { results, errors } = runTolerantBatch(
    d,
    ids,
    (id, _index, db) => {
      const existing = dbGetThought(db, id)
      if (!existing) throw new NotFoundError(`Thought '${id}' not found`)
      if (existing.status !== 'archived') archiveThoughtByIdService(id, db)
    },
    ({ item, message }) => ({ thought_id: item, error: message })
  )

  return { archived: results.length, failed: errors.length, errors }
}

interface ThoughtPage {
  thoughts: Thought[]
  total: number
  limit: number | null
  offset: number
}

export function listThoughtsPageService(
  options: ListThoughtsOptions = {},
  d: Database = getDb()
): ThoughtPage {
  const limit = options.limit === undefined ? THOUGHTS_PAGE_LIMIT_DEFAULT : options.limit
  const offset = options.offset ?? 0
  const thoughts = dbListThoughts(d, { ...options, limit, offset })
  return { thoughts, total: countThoughts(d, options), limit, offset }
}
