import { z } from 'zod/v4'
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { reflectSession } from '../../services/slots.service'
import { listThoughtsService } from '../../services/thoughts.service'
import { resolveProjectId } from './utils'
import { registerActionTool, type ActionArgs } from './action-tool'

const handlers = {
  reflect: {
    run(args: ActionArgs) {
      // Resolved inside the dispatch try so resolution failures return the
      // isError envelope like every other action (audit F9).
      const projectFilter = resolveProjectId(args.project_id as string | undefined, args.cwd as string | undefined)
      return reflectSession({
        summary: args.summary as string | undefined, goals_delta: args.goals_delta as string[] | undefined,
        decisions: args.decisions as string[] | undefined, pending: args.pending as string[] | undefined,
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
    description: `Session management and history. Actions:
- reflect: Record session outcomes (summary, decisions, pending tasks, goal changes). Call at natural breakpoints — after a decision, after finishing a task, after architectural work.
- timeline: List thoughts with pagination (recent activity feed)`,
    inputSchema: {
      action: z.enum(['reflect', 'timeline']).describe('Action'),
      summary: z.string().optional().describe('Brief summary of what was accomplished (reflect only)'),
      goals_delta: z.array(z.string()).optional().describe('Goals to add or remove. Prefix "closed:" to remove. (reflect only)'),
      decisions: z.array(z.string()).optional().describe('Decisions made — each creates an active thought with tag "decision" (reflect only)'),
      pending: z.array(z.string()).optional().describe('Pending tasks — each creates a draft thought with tag "pending" + smart note (reflect only)'),
      wake_days: z.number().int().min(1).max(365).optional().describe('Days before pending items auto-surface (default 7, 1-365, reflect only)'),
      project_id: z.string().optional().describe('Project scope (omit for global)'),
      cwd: z.string().optional().describe('Working directory — auto-resolves project. Always pass this.'),
      status: z.enum(['draft', 'active', 'archived']).optional().describe('Filter by status (timeline only)'),
      limit: z.number().int().min(1).max(500).optional().describe('Max results (default 50, 1-500, timeline only)'),
      offset: z.number().int().min(0).max(1_000_000).optional().describe('Offset for pagination (timeline only)')
    },
    handlers
  })
}
