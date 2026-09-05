import { z } from 'zod/v4'
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import {
  getThoughtById,
  archiveThoughtById,
  deleteThoughtById,
  mergeThoughtsService
} from '../../services/thoughts.service'
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

export function registerMemorySupersede(server: McpServer) {
  server.tool('memory_supersede', `Version and supersede thoughts. Actions:
- archive: Archive a thought (set status=archived). If already archived, permanently delete.
- merge: Merge source into target (source archived, target updated with merged content/tags)`, {
    action: z.enum(['archive', 'merge']).describe('Action'),
    thought_id: z.string().optional().describe('Thought ID (required for archive)'),
    source_id: z.string().optional().describe('Source thought ID — will be archived (required for merge)'),
    target_id: z.string().optional().describe('Target thought ID — will be updated (required for merge)'),
    merged_content: z.string().optional().describe('Merged content (merge only)'),
    merged_tags: z.array(z.string()).optional().describe('Merged tags (merge only)'),
    project_id: z.string().optional().describe('Project ID (merge only)'),
    cwd: z.string().optional().describe('Working directory — auto-resolves project')
  }, async (args) => {
    try {
      if (args.action === 'archive') {
        if (!args.thought_id) return errorResult('thought_id is required for archive action')
        const existing = getThoughtById(args.thought_id)
        if (!existing) return errorResult(`Thought '${args.thought_id}' not found`)
        if (existing.status === 'archived') {
          const deleted = deleteThoughtById(args.thought_id)
          return jsonResult(deleted ? 'Permanently deleted' : 'Delete failed')
        }
        const archived = archiveThoughtById(args.thought_id)
        return jsonResult(archived)
      }

      if (args.action === 'merge') {
        if (!args.source_id) return errorResult('source_id is required for merge action')
        if (!args.target_id) return errorResult('target_id is required for merge action')
        const projectFilter = resolveProjectId(args.project_id, args.cwd)
        const result = mergeThoughtsService(args.source_id, args.target_id, args.merged_content, args.merged_tags, projectFilter)
        return jsonResult(result)
      }

      return errorResult(`Unknown action: ${args.action}`)
    } catch (err) {
      return errorResult(err instanceof Error ? err.message : 'memory_supersede failed')
    }
  })
}
