import { z } from 'zod/v4'
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { getSlots, reflectSession } from '../../services/slots.service'
import { resolveProjectService } from '../../services/projects.service'
import { jsonResult, errorResult } from './utils'

export function registerSlotTools(server: McpServer) {
  server.tool('get_slots', 'Get context slots: persona, pending_items, architecture_decisions, project_context, active_goals', {
    names: z.array(z.string()).optional().describe('Filter by slot names'),
    project_id: z.string().optional().describe('Filter by project'),
    cwd: z.string().optional().describe('Working directory to auto-resolve project when project_id is not provided')
  }, async (args) => {
    try {
      let projectId = args.project_id
      if (!projectId && args.cwd) {
        const project = resolveProjectService(args.cwd)
        if (project) projectId = project.id
      }
      const slots = getSlots({ names: args.names, projectId })
      return jsonResult(slots)
    } catch (err) {
      return errorResult(err instanceof Error ? err.message : 'Failed to get slots')
    }
  })

  server.tool('reflect_session', 'Reflect on a completed work block: record summary, decisions, pending tasks, and goal changes. Call at natural breakpoints — after a decision, after finishing a task, after architectural work — not only at session end.', {
    summary: z.string().optional().describe('Brief summary of what was accomplished (appends to project_context slot)'),
    goals_delta: z.array(z.string()).optional().describe('Goals to add or remove. Prefix "closed:" to remove a goal.'),
    decisions: z.array(z.string()).optional().describe('Decisions made — each creates an active thought with tag "decision"'),
    pending: z.array(z.string()).optional().describe('Pending tasks — each creates a draft thought with tag "pending" + smart note'),
    wake_days: z.number().optional().describe('Days before pending items auto-surface (default 7, range 1-365)'),
    project_id: z.string().optional().describe('Project scope (omit for global)'),
    cwd: z.string().optional().describe('Working directory — auto-resolves project. Always pass this.')
  }, async (args) => {
    try {
      let projectId = args.project_id
      if (!projectId && args.cwd) {
        const project = resolveProjectService(args.cwd)
        if (project) projectId = project.id
      }
      const result = reflectSession({
        summary: args.summary,
        goals_delta: args.goals_delta,
        decisions: args.decisions,
        pending: args.pending,
        wake_days: args.wake_days,
        project_id: projectId
      })
      return jsonResult(result)
    } catch (err) {
      return errorResult(err instanceof Error ? err.message : 'Failed to reflect session')
    }
  })
}
