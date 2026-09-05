import { z } from 'zod/v4'
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { reflectSession } from '../../services/slots.service'
import { listThoughtsService } from '../../services/thoughts.service'
import { resolveProjectService } from '../../services/projects.service'
import { jsonResult, errorResult } from './utils'

function resolveProjectId(projectId?: string, cwd?: string): string | undefined {
  if (projectId) return projectId
  if (cwd) {
    const project = resolveProjectService(cwd)
    if (project) return project.id
  }
  return undefined
}

export function registerMemoryReflect(server: McpServer) {
  server.tool('memory_reflect', `Session management and history. Actions:
- reflect: Record session outcomes (summary, decisions, pending tasks, goal changes). Call at natural breakpoints — after a decision, after finishing a task, after architectural work.
- timeline: List thoughts with pagination (recent activity feed)`, {
    action: z.enum(['reflect', 'timeline']).describe('Action'),
    summary: z.string().optional().describe('Brief summary of what was accomplished (reflect only)'),
    goals_delta: z.array(z.string()).optional().describe('Goals to add or remove. Prefix "closed:" to remove. (reflect only)'),
    decisions: z.array(z.string()).optional().describe('Decisions made — each creates an active thought with tag "decision" (reflect only)'),
    pending: z.array(z.string()).optional().describe('Pending tasks — each creates a draft thought with tag "pending" + smart note (reflect only)'),
    wake_days: z.number().optional().describe('Days before pending items auto-surface (default 7, range 1-365, reflect only)'),
    project_id: z.string().optional().describe('Project scope (omit for global)'),
    cwd: z.string().optional().describe('Working directory — auto-resolves project. Always pass this.'),
    status: z.string().optional().describe('Filter by status (timeline only)'),
    limit: z.number().optional().describe('Max results (default 50, timeline only)'),
    offset: z.number().optional().describe('Offset for pagination (timeline only)')
  }, async (args) => {
    const projectFilter = resolveProjectId(args.project_id, args.cwd)

    try {
      if (args.action === 'reflect') {
        const result = reflectSession({
          summary: args.summary, goals_delta: args.goals_delta,
          decisions: args.decisions, pending: args.pending,
          wake_days: args.wake_days, project_id: projectFilter
        })
        return jsonResult(result)
      }

      if (args.action === 'timeline') {
        const thoughts = listThoughtsService({
          status: args.status as any, project_id: projectFilter,
          limit: args.limit, offset: args.offset
        })
        return jsonResult(thoughts)
      }

      return errorResult(`Unknown action: ${args.action}`)
    } catch (err) {
      return errorResult(err instanceof Error ? err.message : 'memory_reflect failed')
    }
  })
}
