import type { Database } from 'bun:sqlite'
import { config } from '../config'
import { createEdge } from '../db/edges'
import { getClusterMembers } from '../db/cluster-edges'
import { getDb } from '../db'
import { getThoughtLimitsDB } from '../db/settings'
import { pruneThoughtUrlLinks } from '../db/thought_url_links'
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
import { validateContentLength, validateStatus } from '../validation'
import { EdgeAlreadyExistsError, NotFoundError, ValidationError } from '../errors'

export function getThoughtByIdService(id: string, d: Database = getDb()): Thought | null {
  return dbGetThought(d, id) ?? null
}

export function createThoughtWithParentService(
  data: CreateThoughtInput,
  parentId?: string,
  relation?: string,
  d: Database = getDb()
): Thought {
  validateStatus(data.status)
  validateContentLength(data.content, getThoughtLimitsDB(d))
  const create = d.transaction(() => {
    const thought = dbCreateThought(d, data)
    if (parentId) {
      try {
        createEdge(d, parentId, thought.id, relation ?? 'parent')
      } catch (err) {
        // A duplicate edge is expected dedup; anything else is a real failure
        // (e.g. ClusterEdgeValidationError) and must abort the whole create.
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
  return { ...thought, content_language: config.contentLanguage } as Thought
}

// Profile thoughts are persona material and must survive archiving (issue #200).
function assertNotProfileArchive(thought: Thought | null | undefined): void {
  if (thought?.is_profile) {
    throw new ValidationError('Profile thoughts cannot be archived — clear the is_profile flag first')
  }
}

export function updateThoughtByIdService(id: string, data: UpdateThoughtInput, d: Database = getDb()): Thought | null {
  validateStatus(data.status)
  if (data.content !== undefined) {
    validateContentLength(data.content, getThoughtLimitsDB(d), id)
  }
  if (data.status === 'archived') {
    assertNotProfileArchive(dbGetThought(d, id))
  }
  const run = d.transaction(() => {
    const updated = dbUpdateThought(d, id, data)
    // issue #256: updated content may drop `[[key|...]]` markers — prune the
    // thought's orphaned url_links rows in the same transaction as the content
    // update (mirrors the merge path).
    if (updated && data.content !== undefined) {
      pruneThoughtUrlLinks(d, id, data.content)
    }
    return updated
  })
  const updated = run()
  if (!updated) return null
  return { ...updated, content_language: config.contentLanguage } as Thought
}

export function archiveThoughtByIdService(id: string, d: Database = getDb()): Thought | null {
  const thought = dbGetThought(d, id)
  if (!thought) return null
  assertNotProfileArchive(thought)
  return dbArchiveThought(d, id) ?? null
}

export function listThoughtsService(options?: ListThoughtsOptions, d: Database = getDb()): Thought[] {
  return dbListThoughts(d, options)
}

/** One page of thoughts plus the total matching the same filters. */
export interface ThoughtPage {
  thoughts: Thought[]
  /** Number of thoughts matching the filters, ignoring `limit`/`offset`. */
  total: number
  /** Page size applied (`null` = no limit). */
  limit: number | null
  offset: number
}

/**
 * Paginated thought inventory: the page (newest first) together with the total
 * count for the same filters, so a caller can page without a second request.
 */
export function listThoughtsPageService(options: ListThoughtsOptions = {}, d: Database = getDb()): ThoughtPage {
  const limit = options.limit === undefined ? THOUGHTS_PAGE_LIMIT_DEFAULT : options.limit
  const offset = options.offset ?? 0
  const thoughts = dbListThoughts(d, { ...options, limit, offset })
  return { thoughts, total: countThoughts(d, options), limit, offset }
}

export function getClusterMembersService(clusterId: string, d: Database = getDb()): { cluster: Thought; members: Thought[] } {
  const cluster = getThoughtByIdService(clusterId, d)
  if (!cluster) throw new NotFoundError('Thought not found')
  if (!cluster.is_cluster) throw new ValidationError('Not a cluster thought')
  const members = getClusterMembers(d, clusterId)
  return { cluster, members }
}
