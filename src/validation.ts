import { z } from 'zod/v4'
import type { ThoughtLimits } from './db/settings'
import { insertLog } from './logging/log'
import { ValidationError } from './errors'
import { isThoughtStatus } from './types/thought'

export const thoughtStatusSchema = z.enum(['draft', 'active', 'archived'])

export const graphStatusSchema = z.enum(['active', 'draft', 'archived', 'all'])

const GRAPH_LIMIT_MIN = 1
const GRAPH_LIMIT_MAX = 2000
export const graphLimitSchema = z.coerce.number().int().min(GRAPH_LIMIT_MIN).max(GRAPH_LIMIT_MAX)

const GRAPH_OFFSET_MIN = 0
const GRAPH_OFFSET_MAX = 1_000_000
export const graphOffsetSchema = z.coerce.number().int().min(GRAPH_OFFSET_MIN).max(GRAPH_OFFSET_MAX)

const TIMELINE_LIMIT_MIN = 1
const TIMELINE_LIMIT_MAX = 500
export const timelineLimitSchema = z.coerce
  .number()
  .int()
  .min(TIMELINE_LIMIT_MIN)
  .max(TIMELINE_LIMIT_MAX)

export const BATCH_ITEMS_MAX = 1000

const PROPOSALS_LIMIT_MIN = 1
const PROPOSALS_LIMIT_MAX = 1000
export const proposalsLimitSchema = z.coerce
  .number()
  .int()
  .min(PROPOSALS_LIMIT_MIN)
  .max(PROPOSALS_LIMIT_MAX)

export const isoDateTimeSchema = z.iso.datetime()

export function validateStatus(status: string | undefined): void {
  if (status !== undefined && !isThoughtStatus(status)) {
    throw new ValidationError(`Invalid status: ${status}. Must be one of: draft, active, archived`)
  }
}

export function validateContentLength(
  content: string,
  limits: ThoughtLimits,
  thoughtId?: string
): void {
  const { softLimit, hardLimit } = limits
  if (content.length > hardLimit) {
    throw new ValidationError(
      `Thought content exceeds the hard ceiling of ${hardLimit} chars (got ${content.length}). ` +
        `Recommended size is <= ${softLimit} chars; please split it into smaller atomic thoughts.`
    )
  }
  if (content.length > softLimit) {
    insertLog(
      'warning',
      'thought',
      `Thought content exceeds the recommended soft limit of ${softLimit} chars (got ${content.length})`,
      {
        thought_id: thoughtId,
        length: content.length
      }
    )
  }
}
