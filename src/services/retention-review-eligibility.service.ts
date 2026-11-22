import type { Database } from 'bun:sqlite'
import {
  countIncomingActiveRetentionReviewEdges,
  getRetentionReviewEligibilityThought,
  type RetentionReviewEligibilityThought
} from '../db/retention-review'
import { config } from '../config'
import { NotFoundError, ValidationError } from '../errors'
import { asNumber, MS_PER_DAY } from '../utils'

export interface RetentionReviewEligibilityOptions {
  minAgeDays?: number
  importanceFloor?: number
  now?: string
}

export function resolveNow(opts: { now?: string }): string {
  return opts.now ?? new Date().toISOString()
}

export function resolveMinAge(opts: RetentionReviewEligibilityOptions): number {
  const v = asNumber(opts.minAgeDays)
  const resolved = v === undefined ? config.retentionReview.minAgeDays : v
  if (!Number.isFinite(resolved) || resolved <= 0) {
    throw new ValidationError('minAgeDays must be a positive number')
  }
  return resolved
}

export function resolveFloor(opts: RetentionReviewEligibilityOptions): number {
  const v = asNumber(opts.importanceFloor)
  const resolved = v === undefined ? config.retentionReview.importanceFloor : v
  if (!Number.isFinite(resolved) || resolved < 0 || resolved > 1) {
    throw new ValidationError('importanceFloor must be in [0, 1]')
  }
  return resolved
}

export interface EligibilityDetail {
  eligible: boolean
  reasons: string[]
  thought: RetentionReviewEligibilityThought
  incomingActiveEdges: number
}

export function evaluateEligibility(
  id: string,
  d: Database,
  opts: RetentionReviewEligibilityOptions,
  now: string
): EligibilityDetail {
  const row = getRetentionReviewEligibilityThought(d, id)

  if (!row) throw new NotFoundError(`Thought not found: ${id}`)

  const reasons: string[] = []
  const minAgeDays = resolveMinAge(opts)
  const floor = resolveFloor(opts)
  const nowMs = Date.parse(now)

  if (!['archived', 'draft'].includes(row.status)) reasons.push('status not archived/draft')
  if (row.is_protected) reasons.push('protected')
  if (row.is_global) reasons.push('is_global')

  const anchor = row.archived_at ?? row.created_at
  const cutoffMs = nowMs - minAgeDays * MS_PER_DAY
  if (!(Date.parse(anchor) < cutoffMs)) reasons.push('age < minAgeDays')

  if (!(row.importance < floor)) reasons.push('importance >= floor')
  if (row.hit_count !== 0) reasons.push('hit_count != 0')

  const incomingActiveEdges = countIncomingActiveRetentionReviewEdges(d, id)
  if (incomingActiveEdges > 0) reasons.push('incoming active edges')

  if (row.surface_after && Date.parse(row.surface_after) > nowMs)
    reasons.push('surface_after in future')

  return {
    eligible: reasons.length === 0,
    reasons,
    thought: row,
    incomingActiveEdges
  }
}
