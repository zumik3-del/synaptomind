import { createEdge, getClusterForThought, getClusterMembers } from '../db/edges'
import { getDb } from '../db'
import { getThoughtLimits } from '../db/settings'
import { pruneThoughtUrlLinks, upsertThoughtUrlLink } from '../db/thought_url_links'
import {
  type CreateThoughtInput,
  archiveThought as dbArchiveThought,
  createThought as dbCreateThought,
  deleteThought as dbDeleteThought,
  getThought as dbGetThought,
  listThoughts as dbListThoughts,
  updateThought as dbUpdateThought,
  type ListThoughtsOptions,
  type Thought,
  type UpdateThoughtInput
} from '../db/thoughts'
import { insertLog } from '../logging/log'
import { EdgeAlreadyExistsError, NotFoundError, ValidationError } from './errors'
import { transferEdgesFromSource, validateMergePreconditions } from './merge'
const VALID_STATUSES = ['draft', 'active', 'archived'] as const

function validateStatus(status: string | undefined): void {
  if (status !== undefined && !(VALID_STATUSES as readonly string[]).includes(status)) {
    throw new ValidationError(`Invalid status: ${status}. Must be one of: ${VALID_STATUSES.join(', ')}`)
  }
}

export function validateContentLength(content: string, thoughtId?: string): void {
  const { softLimit, hardLimit } = getThoughtLimits()
  if (content.length > hardLimit) {
    throw new ValidationError(
      `Thought content exceeds hard limit of ${hardLimit} chars (got ${content.length}). ` +
        `Please split it into smaller atomic thoughts or raise the hard limit in Settings.`
    )
  }
  if (content.length > softLimit) {
    insertLog(
      'warning',
      'thought',
      `Thought content exceeds soft limit of ${softLimit} chars (got ${content.length})`,
      {
        thought_id: thoughtId,
        length: content.length
      }
    )
  }
}

export function getThoughtById(id: string): Thought | null {
  return dbGetThought(getDb(), id) ?? null
}

export function createThoughtWithParent(data: CreateThoughtInput, parentId?: string, relation?: string): Thought {
  validateStatus(data.status)
  validateContentLength(data.content)
  const d = getDb()
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
  return create()
}

export interface UrlLink {
  text: string
  url: string
}

export function createThoughtWithUrlLinks(
  data: CreateThoughtInput,
  options?: { parentId?: string; relation?: string; urlLinks?: UrlLink[] }
): Thought {
  const d = getDb()
  const run = d.transaction(() => {
    const thought = createThoughtWithParent(data, options?.parentId, options?.relation)
    if (options?.urlLinks && options.urlLinks.length > 0) {
      for (const link of options.urlLinks) {
        upsertThoughtUrlLink(d, thought.id, link.text, link.url, link.text, 0)
      }
    }
    return thought
  })
  return run()
}

// Profile thoughts are persona material and must survive archiving (issue #200).
function assertNotProfileArchive(thought: Thought | null | undefined): void {
  if (thought?.is_profile) {
    throw new ValidationError('Profile thoughts cannot be archived — clear the is_profile flag first')
  }
}

export function updateThoughtById(id: string, data: UpdateThoughtInput): Thought | null {
  validateStatus(data.status)
  if (data.content !== undefined) {
    validateContentLength(data.content, id)
  }
  const d = getDb()
  if (data.status === 'archived') {
    assertNotProfileArchive(dbGetThought(d, id))
  }
  return dbUpdateThought(d, id, data) ?? null
}

export function archiveThoughtById(id: string): Thought | null {
  const d = getDb()
  const thought = dbGetThought(d, id)
  if (!thought) return null
  assertNotProfileArchive(thought)
  return dbArchiveThought(d, id) ?? null
}

export function deleteThoughtById(id: string): boolean {
  return dbDeleteThought(getDb(), id)
}

export function listThoughtsService(options?: ListThoughtsOptions): Thought[] {
  return dbListThoughts(getDb(), options)
}

export function pruneThoughtUrlLinksService(thoughtId: string, content: string): number {
  return pruneThoughtUrlLinks(getDb(), thoughtId, content)
}

export function findClusterForThought(thoughtId: string): Thought | null {
  return getClusterForThought(getDb(), thoughtId)
}

export function getClusterMembersService(clusterId: string): { cluster: Thought; members: Thought[] } {
  const d = getDb()
  const cluster = getThoughtById(clusterId)
  if (!cluster) throw new NotFoundError('Thought not found')
  if (!cluster.is_cluster) throw new ValidationError('Not a cluster thought')
  const members = getClusterMembers(d, clusterId)
  return { cluster, members }
}

export interface MergeResult {
  target: Thought
  transferredEdges: number
}

export interface MergeThoughtsOptions {
  targetId: string
  sourceId: string
  mergedContent?: string
  mergedTags?: string[]
  projectId?: string
}

export function mergeThoughtsService(options: MergeThoughtsOptions): MergeResult {
  const { targetId, sourceId, mergedContent, mergedTags, projectId } = options
  if (sourceId === targetId) {
    throw new ValidationError('source_id and target_id must be different')
  }

  const d = getDb()

  const source = getThoughtById(sourceId)
  if (!source) throw new NotFoundError(`Source thought '${sourceId}' not found`)

  const target = getThoughtById(targetId)
  if (!target) throw new NotFoundError(`Target thought '${targetId}' not found`)

  validateMergePreconditions(source)

  const finalProjectId = projectId ?? target.project_id ?? source.project_id ?? undefined

  const updateData: UpdateThoughtInput = {}
  if (mergedContent !== undefined) updateData.content = mergedContent
  if (mergedTags !== undefined) updateData.tags = mergedTags
  if (finalProjectId !== undefined) updateData.project_id = finalProjectId

  const run = d.transaction(() => {
    if (Object.keys(updateData).length > 0) {
      const updated = dbUpdateThought(d, targetId, updateData)
      if (!updated) throw new NotFoundError(`Target thought '${targetId}' not found during update`)
    }

    // issue #256: merged content may drop `[[key|...]]` markers — prune the
    // target's orphaned url_links rows in the same transaction as the content
    // update (mirrors the PUT route path, which merge otherwise bypasses).
    if (mergedContent !== undefined) {
      pruneThoughtUrlLinks(d, targetId, mergedContent)
    }

    const transferredEdges = transferEdgesFromSource(d, sourceId, targetId)

    dbArchiveThought(d, sourceId)

    return { transferredEdges }
  })

  const counts = run()
  const updatedTarget = getThoughtById(targetId)
  if (!updatedTarget) throw new NotFoundError(`Target thought '${targetId}' not found after merge`)
  return { target: updatedTarget, ...counts }
}
