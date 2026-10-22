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
  createThought as dbCreateThought,
  getThought as dbGetThought,
  listThoughts as dbListThoughts,
  updateThought as dbUpdateThought,
  type ListThoughtsOptions,
  type Thought,
  type UpdateThoughtInput
} from '../db/thoughts'
import { insertLog } from '../logging/log'
import { validateContentLength, validateStatus, BATCH_ITEMS_MAX } from '../validation'
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

/** One `archive_batch` item that could not be archived, with the reason. */
export interface ArchiveBatchError {
  thought_id: string
  error: string
}

/** Outcome of `archiveThoughtsBatchService` (task #1964): counts plus per-item failures. */
export interface ArchiveBatchResult {
  /** Items that ended archived — an already-archived thought counts (idempotent replay). */
  archived: number
  /** Always `errors.length`, so a caller sees the failure count without scanning. */
  failed: number
  errors: ArchiveBatchError[]
}

/**
 * Archive several thoughts in one call (task #1964).
 *
 * Reuses `archiveThoughtByIdService`, so the profile guard (issue #200) and the
 * idempotency of an already-archived thought are unchanged. The batch runs in ONE
 * transaction and reports per-item failures instead of aborting the rest — the
 * contract `bulkCreateThoughtsService` already uses: a failure is collected, the
 * items that succeeded still commit, and nothing is swallowed silently.
 */
export function archiveThoughtsBatchService(ids: string[], d: Database = getDb()): ArchiveBatchResult {
  if (!Array.isArray(ids) || ids.length === 0) {
    throw new ValidationError('thought_ids is required and must not be empty')
  }
  if (ids.length > BATCH_ITEMS_MAX) {
    throw new ValidationError(`thought_ids accepts at most ${BATCH_ITEMS_MAX} ids per call (got ${ids.length})`)
  }

  let archived = 0
  const errors: ArchiveBatchError[] = []

  const run = d.transaction(() => {
    for (const id of ids) {
      try {
        const existing = dbGetThought(d, id)
        if (!existing) throw new NotFoundError(`Thought '${id}' not found`)
        // Mirror the single-item action: archiving an archived thought is a no-op,
        // not a re-stamp of `archived_at`.
        if (existing.status !== 'archived') archiveThoughtByIdService(id, d)
        archived++
      } catch (err) {
        errors.push({ thought_id: id, error: err instanceof Error ? err.message : String(err) })
      }
    }
  })
  run()

  return { archived, failed: errors.length, errors }
}

export function listThoughtsService(options?: ListThoughtsOptions, d: Database = getDb()): Thought[] {
  return dbListThoughts(d, options)
}

export function getClusterMembersService(clusterId: string, d: Database = getDb()): { cluster: Thought; members: Thought[] } {
  const cluster = getThoughtByIdService(clusterId, d)
  if (!cluster) throw new NotFoundError('Thought not found')
  if (!cluster.is_cluster) throw new ValidationError('Not a cluster thought')
  const members = getClusterMembers(d, clusterId)
  return { cluster, members }
}
