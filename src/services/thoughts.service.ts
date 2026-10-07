import type { Database } from 'bun:sqlite'
import { config } from '../config'
import { createEdge, getClusterMembers } from '../db/edges'
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
import { validateContentLength, validateStatus } from '../validation'
import { EdgeAlreadyExistsError, NotFoundError, ValidationError } from '../errors'
import { enqueueTriageItem } from './triage.service'

// Re-exports for backward compatibility — implementations live in focused services.
export { getMergePreviewService, mergeThoughtsService } from './merge.service'
export { bulkCreateThoughtsService, type BulkCreateItem } from './bulk.service'
export { createThoughtWithUrlLinks } from './url_links.service'

export function getThoughtById(id: string, d: Database = getDb()): Thought | null {
  return dbGetThought(d, id) ?? null
}

export function createThoughtWithParent(
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
  // ADR 2026-09-29 §2.3.2: after the create transaction commits, give every
  // newly created plain draft one triage item. Best-effort — triage must never
  // fail a create; `enqueueTriageItem`'s guard is the sole classifier (draft &&
  // !cluster && !profile && !scheduled reminder).
  try {
    enqueueTriageItem(thought, d)
  } catch (err) {
    insertLog('warning', 'triage', `Failed to enqueue triage item for thought ${thought.id}`, {
      thought_id: thought.id,
      error: err instanceof Error ? err.message : String(err)
    })
  }
  return { ...thought, content_language: config.contentLanguage } as Thought
}

// Profile thoughts are persona material and must survive archiving (issue #200).
function assertNotProfileArchive(thought: Thought | null | undefined): void {
  if (thought?.is_profile) {
    throw new ValidationError('Profile thoughts cannot be archived — clear the is_profile flag first')
  }
}

export function updateThoughtById(id: string, data: UpdateThoughtInput, d: Database = getDb()): Thought | null {
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

export function archiveThoughtById(id: string, d: Database = getDb()): Thought | null {
  const thought = dbGetThought(d, id)
  if (!thought) return null
  assertNotProfileArchive(thought)
  return dbArchiveThought(d, id) ?? null
}

export function listThoughtsService(options?: ListThoughtsOptions, d: Database = getDb()): Thought[] {
  return dbListThoughts(d, options)
}

export function getClusterMembersService(clusterId: string, d: Database = getDb()): { cluster: Thought; members: Thought[] } {
  const cluster = getThoughtById(clusterId, d)
  if (!cluster) throw new NotFoundError('Thought not found')
  if (!cluster.is_cluster) throw new ValidationError('Not a cluster thought')
  const members = getClusterMembers(d, clusterId)
  return { cluster, members }
}
