import { z } from 'zod/v4'
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { reflectSessionService } from '../../services/slots.service'
import { listThoughtsPageService, type Thought } from '../../services/thoughts.service'
import { thoughtStatusSchema, timelineLimitSchema } from '../../validation'
import { itemEnvelope, collectionEnvelope, requireEnvelopeScope } from './envelope'
import { shapeThought } from './utils'
import { registerActionTool, type ActionArgs } from './action-tool'

const handlers = {
  reflect: {
    run(args: ActionArgs) {
      // Resolved inside the dispatch try so resolution failures return the
      // isError envelope like every other action (audit F9).
      const { scope, warnings, projectId } = requireEnvelopeScope(args.cwd, 'memory_reflect', 'reflect')
      const result = reflectSessionService({
        summary: args.summary as string | undefined,
        goals_add: args.goals_add as string[] | undefined,
        goals_remove: args.goals_remove as string[] | undefined,
        decisions: args.decisions as string[] | undefined,
        pending: args.pending as string[] | undefined,
        wake_days: args.wake_days as number | undefined, project_id: projectId
      })
      return itemEnvelope('reflect', result, { scope, warnings })
    }
  },

  timeline: {
    run(args: ActionArgs) {
      const { scope, warnings, projectId } = requireEnvelopeScope(args.cwd, 'memory_reflect', 'timeline')
      const page = listThoughtsPageService({
        status: args.status as 'draft' | 'active' | 'archived' | undefined, project_id: projectId,
        limit: args.limit as number | undefined, offset: args.offset as number | undefined
      })
      // Same read-surface hygiene as every other thought listing: tag names as
      // plain strings, flag columns as booleans. Paging metadata belongs to
      // meta.counts, never to a row.
      const items = page.thoughts.map((t: Thought) => shapeThought(t))
      return collectionEnvelope('timeline', items, {
        scope,
        warnings,
        total: page.total,
        filtered_out: Math.max(0, page.total - items.length),
        counts: { limit: page.limit ?? 0, offset: page.offset }
      })
    }
  }
}

export function registerMemoryReflect(server: McpServer) {
  registerActionTool(server, {
    name: 'memory_reflect',
    description: `Session management. Every action answers { items, meta } (timeline) or { item, meta } (reflect); meta = { action, scope, counts, degraded, warnings }. cwd is REQUIRED for both actions. Actions: reflect (summary, decisions, pending, goals), timeline (paginated thought inventory with the shared read-surface hygiene; limit/offset/total ride in meta.counts, never in a row).`,
    inputSchema: {
      action: z.enum(['reflect', 'timeline']).describe('Action'),
      summary: z.string().optional().describe('Brief summary of what was accomplished. OPTIONAL for "reflect". IGNORED for "timeline".'),
      goals_add: z.array(z.string()).optional().describe('Goals to add to active_goals — a goal already stored is not added twice. OPTIONAL for "reflect". IGNORED for "timeline".'),
      goals_remove: z.array(z.string()).optional().describe('Goals to remove from active_goals — matched case-insensitively against the stored goals. OPTIONAL for "reflect". IGNORED for "timeline".'),
      decisions: z.array(z.string()).optional().describe('Decisions made — each creates an active thought tagged "decision" and "reflect". OPTIONAL for "reflect". IGNORED for "timeline".'),
      pending: z.array(z.string()).optional().describe('Pending tasks — each creates a draft thought tagged "pending" and "reflect" that surfaces in the frontier after wake_days. OPTIONAL for "reflect". IGNORED for "timeline".'),
      wake_days: z.number().int().min(1).max(365).optional().describe('Days before pending items surface in the frontier (default 7, 1-365). OPTIONAL for "reflect". IGNORED for "timeline".'),
      project_id: z.never({ error: 'project_id was removed; use cwd' }).optional().describe('Removed; use cwd.'),
      cwd: z.string().optional().describe('Working directory — REQUIRED for both actions; resolves the project scope reported in meta.scope.'),
      status: thoughtStatusSchema.optional().describe('Filter by status (default all). OPTIONAL for "timeline". IGNORED for "reflect".'),
      limit: timelineLimitSchema.optional().describe('Max results (default 50, 1-500). OPTIONAL for "timeline". IGNORED for "reflect".'),
      offset: z.number().int().min(0).max(1_000_000).optional().describe('Offset for pagination. OPTIONAL for "timeline". IGNORED for "reflect".'),
      // Tombstone for the retired goals argument: only goals_add /
      // goals_remove are advertised.
      goals_delta: z.never({ error: 'goals_delta was removed; use goals_add / goals_remove' }).optional().describe('Removed; use goals_add / goals_remove.'),
    },
    handlers
  })
}
