import type { Database } from 'bun:sqlite'
import { createEdge, getEdgesForThought, toEdgeView, type EdgeView } from '../db/edges'
import { getDb } from '../db'
import {
  archiveThought as dbArchiveThought,
  updateThought as dbUpdateThought,
  type Thought,
  type UpdateThoughtInput
} from '../db/thoughts'
import { pruneThoughtUrlLinks } from '../db/thought_url_links'
import { NotFoundError, ValidationError } from '../errors'
import { transferEdgesFromSource, validateMergePreconditions } from './merge'
import { getThoughtById } from './thoughts.service'

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
