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
      const projectFilter = resolveProjectId(args.project_id as string | undefined, args.cwd as string | undefined)
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
      const projectFilter = resolveProjectId(args.project_id as string | undefined, args.cwd as string | undefined)
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
      summary: z.string().optional().describe('Brief summary of what was accomplished (reflect only)'),
      goals_add: z.array(z.string()).optional().describe('Goals to add to active_goals — a goal already stored is not added twice (reflect only)'),
      goals_remove: z.array(z.string()).optional().describe('Goals to remove from active_goals — matched case-insensitively against the stored goals (reflect only)'),
      decisions: z.array(z.string()).optional().describe('Decisions made — each creates an active thought tagged "decision" and "reflect" (reflect only)'),
      pending: z.array(z.string()).optional().describe('Pending tasks — each creates a draft thought tagged "pending" and "reflect" that surfaces in the frontier after wake_days (reflect only)'),
      wake_days: z.number().int().min(1).max(365).optional().describe('Days before pending items surface in the frontier (default 7, 1-365, reflect only)'),
      project_id: z.string().optional().describe('Project scope (omit for global)'),
      cwd: z.string().optional().describe('Working directory — auto-resolves project. Always pass this.'),
      status: thoughtStatusSchema.optional().describe('Filter by status (timeline only)'),
      limit: timelineLimitSchema.optional().describe('Max results (default 50, 1-500, timeline only)'),
      offset: z.number().int().min(0).max(1_000_000).optional().describe('Offset for pagination (timeline only)'),
      // Tombstone for the retired goals argument: only goals_add /
      // goals_remove are advertised.
      goals_delta: z.never({ error: 'goals_delta was removed; use goals_add / goals_remove' }).optional()
    },
    handlers
  })
}
