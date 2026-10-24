import { z } from 'zod/v4'
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { reflectSessionService } from '../../services/slots.service'
import { listThoughtsService } from '../../services/thoughts.service'
import { thoughtStatusSchema, timelineLimitSchema } from '../../validation'
import { resolveProjectId } from './utils'
import { registerActionTool, type ActionArgs } from './action-tool'

const handlers = {
  reflect: {
    run(args: ActionArgs) {
      // Resolved inside the dispatch try so resolution failures return the
      // isError envelope like every other action (audit F9).
      const projectFilter = resolveProjectId(args.cwd as string | undefined)
      return reflectSessionService({
        summary: args.summary as string | undefined,
        goals_add: args.goals_add as string[] | undefined,
        goals_remove: args.goals_remove as string[] | undefined,
        decisions: args.decisions as string[] | undefined,
        pending: args.pending as string[] | undefined,
        wake_days: args.wake_days as number | undefined, project_id: projectFilter
      })
    }
  },

  timeline: {
    run(args: ActionArgs) {
      const projectFilter = resolveProjectId(args.cwd as string | undefined)
      return listThoughtsService({
        status: args.status as 'draft' | 'active' | 'archived' | undefined, project_id: projectFilter,
        limit: args.limit as number | undefined, offset: args.offset as number | undefined
      })
    }
  }
}

export function registerMemoryReflect(server: McpServer) {
  registerActionTool(server, {
    name: 'memory_reflect',
    description: `Session management. Actions: reflect (summary, decisions, pending, goals), timeline (paginated).`,
    inputSchema: {
      action: z.enum(['reflect', 'timeline']).describe('Action'),
      summary: z.string().optional().describe('Brief summary of what was accomplished. OPTIONAL for "reflect". IGNORED for "timeline".'),
      goals_add: z.array(z.string()).optional().describe('Goals to add to active_goals — a goal already stored is not added twice. OPTIONAL for "reflect". IGNORED for "timeline".'),
      goals_remove: z.array(z.string()).optional().describe('Goals to remove from active_goals — matched case-insensitively against the stored goals. OPTIONAL for "reflect". IGNORED for "timeline".'),
      decisions: z.array(z.string()).optional().describe('Decisions made — each creates an active thought tagged "decision" and "reflect". OPTIONAL for "reflect". IGNORED for "timeline".'),
      pending: z.array(z.string()).optional().describe('Pending tasks — each creates a draft thought tagged "pending" and "reflect" that surfaces in the frontier after wake_days. OPTIONAL for "reflect". IGNORED for "timeline".'),
      wake_days: z.number().int().min(1).max(365).optional().describe('Days before pending items surface in the frontier (default 7, 1-365). OPTIONAL for "reflect". IGNORED for "timeline".'),
      project_id: z.never({ error: 'project_id was removed; use cwd' }).optional().describe('Removed; use cwd.'),
      cwd: z.string().optional().describe('Working directory — auto-resolves project. OPTIONAL for "reflect" and "timeline" (always pass).'),
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
