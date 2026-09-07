import type { Database } from 'bun:sqlite'
import { config } from '../config'
import { createEdge, getClusterForThought, getClusterMembers, getEdgesForThought, toEdgeView, type EdgeView } from '../db/edges'
import { getDb } from '../db'
import { getThoughtLimitsDB } from '../db/settings'
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
import type { ThoughtStatus } from '../types/thought'
import { validateContentLength, validateStatus } from '../validation'
import { EdgeAlreadyExistsError, NotFoundError, ValidationError } from '../errors'
import { transferEdgesFromSource, validateMergePreconditions } from './merge'

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
  return { ...thought, content_language: config.contentLanguage } as Thought
}

export interface UrlLink {
  text: string
  url: string
}

export function createThoughtWithUrlLinks(
  data: CreateThoughtInput,
  options?: { parentId?: string; relation?: string; urlLinks?: UrlLink[] },
  d: Database = getDb()
): Thought {
  const run = d.transaction(() => {
    const thought = createThoughtWithParent(data, options?.parentId, options?.relation, d)
    if (options?.urlLinks && options.urlLinks.length > 0) {
      for (const link of options.urlLinks) {
        upsertThoughtUrlLink(d, thought.id, link.text, link.url, link.text, 0)
      }
    }
    return thought
  })
  const thought = run()
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

export function deleteThoughtById(id: string, d: Database = getDb()): boolean {
  return dbDeleteThought(d, id)
}

export function listThoughtsService(options?: ListThoughtsOptions, d: Database = getDb()): Thought[] {
  return dbListThoughts(d, options)
}

export function pruneThoughtUrlLinksService(thoughtId: string, content: string, d: Database = getDb()): number {
  return pruneThoughtUrlLinks(d, thoughtId, content)
}

export function findClusterForThought(thoughtId: string, d: Database = getDb()): Thought | null {
  return getClusterForThought(d, thoughtId)
}

export function getClusterMembersService(clusterId: string, d: Database = getDb()): { cluster: Thought; members: Thought[] } {
  const cluster = getThoughtById(clusterId, d)
  if (!cluster) throw new NotFoundError('Thought not found')
  if (!cluster.is_cluster) throw new ValidationError('Not a cluster thought')
  const members = getClusterMembers(d, clusterId)
  return { cluster, members }
}

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

export interface BulkCreateResult {
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

export interface MergePreview {
  mode: 'preview'
  source: Thought & { edges: EdgeView[] }
  target: Thought
}

export function getMergePreviewService(sourceId: string, targetId: string, d: Database = getDb()): MergePreview | null {
  const source = getThoughtById(sourceId, d)
  const target = getThoughtById(targetId, d)
  if (!source || !target) return null
  return {
    mode: 'preview',
    source: { ...source, edges: getEdgesForThought(d, sourceId).map(toEdgeView) },
    target
  }
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

export function mergeThoughtsService(options: MergeThoughtsOptions, d: Database = getDb()): MergeResult {
  const { targetId, sourceId, mergedContent, mergedTags, projectId } = options
  if (sourceId === targetId) {
    throw new ValidationError('source_id and target_id must be different')
  }

  const source = getThoughtById(sourceId, d)
  if (!source) throw new NotFoundError(`Source thought '${sourceId}' not found`)

  const target = getThoughtById(targetId, d)
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

    createEdge(d, targetId, sourceId, 'replaces')

    return { transferredEdges }
  })

  const counts = run()
  const updatedTarget = getThoughtById(targetId, d)
  if (!updatedTarget) throw new NotFoundError(`Target thought '${targetId}' not found after merge`)
  return { target: updatedTarget, ...counts }
}
