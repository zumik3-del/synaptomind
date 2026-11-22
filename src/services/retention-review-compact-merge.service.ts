import type { Database } from 'bun:sqlite'
import {
  findActiveOrDraftRetentionReviewThoughtByHash,
  getRetentionReviewCreatedSummaryState
} from '../db/retention-review'
import { getDb } from '../db'
import { createThought as dbCreateThought } from '../db/thoughts'
import { getThoughtTags } from '../db/tags'
import { RetentionReviewIneligibleError, ValidationError } from '../errors'
import { mergeThoughtsService } from './merge.service'
import { computeContentHash } from '../utils'
import { BATCH_ITEMS_MAX } from '../validation'
import { insertLog } from '../logging/log'
import { evaluateEligibility, resolveNow } from './retention-review-eligibility.service'
import type { RetentionReviewDeleteOptions } from './retention-review-delete-protect.service'

export interface RetentionReviewCompactOptions extends RetentionReviewDeleteOptions {
  source_ids: string[]
  summary: string | { content: string; tags?: string[]; project_id?: string }
  force?: boolean
}

export function compactRetentionReviewCandidatesService(
  options: RetentionReviewCompactOptions,
  d: Database = getDb()
): {
  status: 'preview' | 'compacted'
  preview: boolean
  confirm: boolean
  source_ids: string[]
  summary?: ReturnType<typeof dbCreateThought>
  instruction?: string
} {
  const { source_ids, summary: summaryInput, force = false, confirm = false } = options
  if (
    !Array.isArray(source_ids) ||
    source_ids.length === 0 ||
    source_ids.some(id => typeof id !== 'string' || !id.trim())
  ) {
    throw new ValidationError('source_ids must be a non-empty array of thought IDs')
  }
  if (source_ids.length > BATCH_ITEMS_MAX) {
    throw new ValidationError(
      `source_ids accepts at most ${BATCH_ITEMS_MAX} ids per call (got ${source_ids.length})`
    )
  }
  if (new Set(source_ids).size !== source_ids.length)
    throw new ValidationError('source_ids must be distinct')
  const summaryObject = typeof summaryInput === 'string' ? { content: summaryInput } : summaryInput
  const summary = summaryObject?.content
  if (typeof summary !== 'string' || !summary.trim())
    throw new ValidationError('summary.content must be non-empty')
  if (
    summaryObject.tags !== undefined &&
    (!Array.isArray(summaryObject.tags) || summaryObject.tags.some(tag => typeof tag !== 'string'))
  ) {
    throw new ValidationError('summary.tags must be an array of strings')
  }
  if (
    summaryObject.project_id !== undefined &&
    (typeof summaryObject.project_id !== 'string' || !summaryObject.project_id.trim())
  ) {
    throw new ValidationError('summary.project_id must be non-empty')
  }

  const now = resolveNow(options)
  const sources = source_ids.map(id => {
    const eligibility = evaluateEligibility(id, d, options, now)
    if (eligibility.thought.is_protected)
      throw new RetentionReviewIneligibleError(`Thought ${id} is protected`)
    if (!force && !eligibility.eligible) {
      throw new RetentionReviewIneligibleError(
        `Thought ${id} is not a current retention-review candidate: ${eligibility.reasons.join(', ')}`
      )
    }
    return eligibility.thought
  })
  const projectIds = new Set(sources.map(source => source.project_id))
  if (projectIds.size !== 1) throw new ValidationError('source_ids must belong to the same project')
  if (!confirm)
    return {
      status: 'preview',
      preview: true,
      confirm: false,
      source_ids,
      instruction:
        'Confirm this exact source group and summary by calling again with confirm: true.'
    }

  const run = d.transaction(() => {
    const latest = sources.map(({ id }) => {
      const eligibility = evaluateEligibility(id, d, options, now)
      if (eligibility.thought.is_protected || (!force && !eligibility.eligible)) {
        throw new RetentionReviewIneligibleError(
          `Thought ${id} is no longer an eligible retention-review candidate: ${eligibility.reasons.join(', ')}`
        )
      }
      return eligibility.thought
    })
    if (new Set(latest.map(source => source.project_id)).size !== 1) {
      throw new RetentionReviewIneligibleError('Sources no longer belong to the same project')
    }
    const tags =
      summaryObject.tags === undefined
        ? [...new Set(latest.flatMap(source => getThoughtTags(d, source.id).map(tag => tag.name)))]
        : [...new Set(summaryObject.tags)]
    const projectId = summaryObject.project_id ?? latest[0].project_id
    const matchingThought = findActiveOrDraftRetentionReviewThoughtByHash(
      d,
      computeContentHash(summary.trim(), projectId),
      projectId
    )
    if (matchingThought) {
      throw new RetentionReviewIneligibleError(
        'Summary content matches an existing draft or active thought'
      )
    }
    const created = dbCreateThought(d, {
      content: summary.trim(),
      status: 'active',
      project_id: projectId,
      tags,
      is_protected: true
    })
    const summaryRow = getRetentionReviewCreatedSummaryState(d, created.id)
    if (summaryRow?.status !== 'active' || !summaryRow?.is_protected) {
      throw new RetentionReviewIneligibleError(
        'Summary content matches an existing draft or unprotected thought'
      )
    }
    for (const source of latest) {
      mergeThoughtsService(
        {
          targetId: created.id,
          sourceId: source.id,
          mergedContent: summary.trim(),
          mergedTags: tags,
          allowArchivedSource: true
        },
        d
      )
    }
    return created
  })
  const created = run()
  insertLog('info', 'retention-review', `Compacted retention-review sources into ${created.id}`, {
    summary_id: created.id,
    source_ids
  })
  return { status: 'compacted', preview: false, confirm: true, source_ids, summary: created }
}
