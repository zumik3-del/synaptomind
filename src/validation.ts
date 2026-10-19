import { z } from 'zod/v4'
import type { ThoughtLimits } from './db/settings'
import { insertLog } from './logging/log'
import { ValidationError } from './errors'
import { isThoughtStatus } from './types/thought'

// ── Shared request contract (HTTP + MCP) ─────────────────────────────────────
//
// The lifecycle `status` enum and the `limit` ranges are the fields both
// surfaces accept with identical semantics (audit M8); the schemas are declared
// once here and imported by the HTTP adapters (`src/api/*`) and the MCP tool
// input schemas (`src/mcp/tools/*`) so a range can never drift between them.

/** Lifecycle status accepted by every thought-surface request. */
export const thoughtStatusSchema = z.enum(['draft', 'active', 'archived'])

/** Graph status filter: the lifecycle statuses plus the `all` aggregate. */
export const graphStatusSchema = z.enum(['active', 'draft', 'archived', 'all'])

/** Node cap for the graph surface (`GET /api/graph`, `memory_crystallize graph`). */
export const GRAPH_LIMIT_DEFAULT = 500
export const GRAPH_LIMIT_MIN = 1
export const GRAPH_LIMIT_MAX = 2000
export const graphLimitSchema = z.coerce.number().int().min(GRAPH_LIMIT_MIN).max(GRAPH_LIMIT_MAX)

/** Page size for the timeline surface (`GET /api/thoughts/timeline`, `memory_reflect timeline`). */
export const TIMELINE_LIMIT_DEFAULT = 50
export const TIMELINE_LIMIT_MIN = 1
export const TIMELINE_LIMIT_MAX = 500
export const timelineLimitSchema = z.coerce.number().int().min(TIMELINE_LIMIT_MIN).max(TIMELINE_LIMIT_MAX)

/** Page size for the proposal queue (`GET /api/proposals`, `memory_review action=list`). */
export const PROPOSALS_LIMIT_DEFAULT = 100
export const PROPOSALS_LIMIT_MIN = 1
export const PROPOSALS_LIMIT_MAX = 1000
export const proposalsLimitSchema = z.coerce.number().int().min(PROPOSALS_LIMIT_MIN).max(PROPOSALS_LIMIT_MAX)

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
