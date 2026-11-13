import type { Database } from 'bun:sqlite'
import {
  createEdge,
  getEdgesForThought,
  getSourceEdgesForThoughtBounded,
  toEdgeView,
  type EdgeView
} from '../db/edges'
import { getDb } from '../db'
import {
  archiveThought as dbArchiveThought,
  updateThought as dbUpdateThought,
  type Thought,
  type UpdateThoughtInput
} from '../db/thoughts'
import { pruneThoughtUrlLinks } from '../db/thought_url_links'
import { NotFoundError, ValidationError } from '../errors'
import { transferEdgesFromSource, validateMergePreconditions } from './merge-helpers.service'
import { getThoughtByIdService } from './thoughts.service'

export interface MergePreview {
  mode: 'preview'
  source: Thought & { edges: EdgeView[] }
  target: Thought
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
  allowArchivedSource?: boolean
}

function lookupMergeSourceTarget(
  sourceId: string,
  targetId: string,
  d: Database
): { source: Thought; target: Thought } | null {
  const source = getThoughtByIdService(sourceId, d)
  const target = getThoughtByIdService(targetId, d)
  if (!source || !target) return null
  return { source, target }
}

export function getMergePreviewService(
  sourceId: string,
  targetId: string,
  d: Database = getDb()
): MergePreview | null {
  const found = lookupMergeSourceTarget(sourceId, targetId, d)
  if (!found) return null
  const { source, target } = found
  return {
    mode: 'preview',
    source: { ...source, edges: getEdgesForThought(d, sourceId).map(toEdgeView) },
    target
  }
}

export function getBoundedMergePreviewService(
  sourceId: string,
  targetId: string,
  edgeLimit: number,
  d: Database = getDb()
):
  | (Omit<MergePreview, 'source'> & {
      source: Omit<MergePreview['source'], 'edges'> & { edges: EdgeView[] }
      sourceEdgeCount: number
    })
  | null {
  const found = lookupMergeSourceTarget(sourceId, targetId, d)
  if (!found) return null
  const { source, target } = found
  const { edges, count } = getSourceEdgesForThoughtBounded(d, sourceId, edgeLimit)
  return {
    mode: 'preview',
    source: { ...source, edges: edges.map(toEdgeView) },
    target,
    sourceEdgeCount: count
  }
}

export function mergeThoughtsService(
  options: MergeThoughtsOptions,
  d: Database = getDb()
): MergeResult {
  const {
    targetId,
    sourceId,
    mergedContent,
    mergedTags,
    projectId,
    allowArchivedSource = false
  } = options
  if (sourceId === targetId) {
    throw new ValidationError('source_id and target_id must be different')
  }

  const source = getThoughtByIdService(sourceId, d)
  if (!source) throw new NotFoundError(`Source thought '${sourceId}' not found`)

  const target = getThoughtByIdService(targetId, d)
  if (!target) throw new NotFoundError(`Target thought '${targetId}' not found`)

  validateMergePreconditions(source, allowArchivedSource)

  const finalProjectId = projectId ?? target.project_id ?? source.project_id ?? undefined

  const updateData: UpdateThoughtInput = {}
  if (mergedContent !== undefined) updateData.content = mergedContent
  if (mergedTags !== undefined) updateData.tags = mergedTags
  if (finalProjectId !== undefined) updateData.project_id = finalProjectId

  const run = d.transaction(() => {
    const currentSource = getThoughtByIdService(sourceId, d)
    if (!currentSource)
      throw new NotFoundError(`Source thought '${sourceId}' not found during merge`)
    validateMergePreconditions(currentSource, allowArchivedSource)

    if (Object.keys(updateData).length > 0) {
      const updated = dbUpdateThought(d, targetId, updateData)
      if (!updated) throw new NotFoundError(`Target thought '${targetId}' not found during update`)
    }

    // Must stay in this transaction: merge otherwise bypasses the PUT route's url-link prune.
    if (mergedContent !== undefined) {
      pruneThoughtUrlLinks(d, targetId, mergedContent)
    }

    const transferredEdges = transferEdgesFromSource(sourceId, targetId, d)

    dbArchiveThought(d, sourceId)

    createEdge(d, targetId, sourceId, 'replaces')

    return { transferredEdges }
  })

  const counts = run()
  const updatedTarget = getThoughtByIdService(targetId, d)
  if (!updatedTarget) throw new NotFoundError(`Target thought '${targetId}' not found after merge`)
  return { target: updatedTarget, ...counts }
}
