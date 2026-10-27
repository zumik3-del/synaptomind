import { z } from 'zod/v4'
import type { ThoughtLimits } from './db/settings'
import { insertLog } from './logging/log'
import { ValidationError } from './errors'
import { isThoughtStatus } from './types/thought'

// ── Shared request contract (MCP) ───────────────────────────────────────────
//
// The lifecycle `status` enum and the `limit` ranges are declared once here and
// imported by the MCP tool input schemas (`src/mcp/tools/*`), so a range can
// never drift between tools. The HTTP surface is an ops plane (ADR 2026-10-26)
// and shares no request contract with the agent wire.

/** Lifecycle status accepted by every thought-surface request. */
export const thoughtStatusSchema = z.enum(['draft', 'active', 'archived'])

/** Graph status filter: the lifecycle statuses plus the `all` aggregate. */
export const graphStatusSchema = z.enum(['active', 'draft', 'archived', 'all'])

/** Node cap for the graph surface (`memory_crystallize graph`). */
const GRAPH_LIMIT_MIN = 1
const GRAPH_LIMIT_MAX = 2000
export const graphLimitSchema = z.coerce.number().int().min(GRAPH_LIMIT_MIN).max(GRAPH_LIMIT_MAX)

/** Page offset for the graph surface (`memory_crystallize graph`). */
const GRAPH_OFFSET_MIN = 0
const GRAPH_OFFSET_MAX = 1_000_000
export const graphOffsetSchema = z.coerce.number().int().min(GRAPH_OFFSET_MIN).max(GRAPH_OFFSET_MAX)

/** Page size for the timeline surface (`memory_reflect timeline`). */
const TIMELINE_LIMIT_MIN = 1
const TIMELINE_LIMIT_MAX = 500
export const timelineLimitSchema = z.coerce.number().int().min(TIMELINE_LIMIT_MIN).max(TIMELINE_LIMIT_MAX)

/**
 * Item ceiling for the batch write actions (`memory_supersede action=archive_batch`,
 * `memory_store action=link_batch`, task #1964).
 *
 * Like `bulkCreateThoughtsService`'s 10000-thought ceiling: a safety bound on one
 * transaction, not a tuning knob, and no config key or env var. An over-long batch
 * is refused whole (never a silent prefix) at the MCP action schema and again in the
 * service.
 */
export const BATCH_ITEMS_MAX = 1000

/** Page size for the proposal queue (`edge_review action=list`). */
const PROPOSALS_LIMIT_MIN = 1
const PROPOSALS_LIMIT_MAX = 1000
export const proposalsLimitSchema = z.coerce.number().int().min(PROPOSALS_LIMIT_MIN).max(PROPOSALS_LIMIT_MAX)

/** ISO-8601 UTC datetime (the format stored timestamps use). */
export const isoDateTimeSchema = z.iso.datetime()

export function validateStatus(status: string | undefined): void {
  if (status !== undefined && !isThoughtStatus(status)) {
    throw new ValidationError(`Invalid status: ${status}. Must be one of: draft, active, archived`)
  }
}

export function validateContentLength(content: string, limits: ThoughtLimits, thoughtId?: string): void {
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
