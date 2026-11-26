import type { Database } from 'bun:sqlite'
import {
  countRetentionReviewDependents,
  type RetentionReviewDependentCounts
} from '../db/retention-review'
import { getDb } from '../db'
import { deleteThought } from '../db/thoughts'
import { RetentionReviewIneligibleError } from '../errors'
import { insertLog } from '../logging/log'
import type { RetentionReviewQueryOptions } from './retention-review.service'
import { evaluateEligibility, resolveNow } from './retention-review-eligibility.service'

export interface RetentionReviewDeleteOptions extends RetentionReviewQueryOptions {
  confirm?: boolean
}

export function deleteRetentionReviewCandidateService(
  id: string,
  opts: RetentionReviewDeleteOptions = {},
  d: Database = getDb()
): {
  status: string
  action: string
  deleted: boolean
  preview: boolean
  confirm: boolean
  thought_id: string
  dependents?: RetentionReviewDependentCounts
  instruction?: string
} {
  const confirm = opts.confirm ?? false
  const now = resolveNow(opts)

  const elig = evaluateEligibility(id, d, opts, now)
  if (!elig.eligible) {
    throw new RetentionReviewIneligibleError(
      `Thought ${id} is not an eligible retention-review candidate: ${elig.reasons.join(', ')}`
    )
  }

  const dependents = countRetentionReviewDependents(d, id)

  if (!confirm) {
    return {
      status: 'preview',
      action: 'preview',
      deleted: false,
      preview: true,
      confirm: false,
      thought_id: id,
      dependents,
      instruction: `Call again with confirm: true to permanently delete thought ${id}.`
    }
  }

  d.transaction(() => {
    const elig2 = evaluateEligibility(id, d, opts, now)
    if (!elig2.eligible) {
      throw new RetentionReviewIneligibleError(
        `Thought ${id} is not an eligible retention-review candidate: ${elig2.reasons.join(', ')}`
      )
    }
    deleteThought(d, id)
  })()

  insertLog('info', 'retention-review', `Deleted retention-review thought ${id}`, {
    thought_id: id
  })

  return {
    status: 'deleted',
    action: 'deleted',
    deleted: true,
    preview: false,
    confirm: true,
    thought_id: id,
    dependents
  }
}
