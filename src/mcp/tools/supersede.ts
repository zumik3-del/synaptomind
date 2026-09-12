import { z } from 'zod/v4'
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import {
  getThoughtById,
  archiveThoughtById,
  mergeThoughtsService
} from '../../services/thoughts.service'
import { resolveProjectId } from './utils'
import { registerActionTool, requiredString, type ActionArgs } from './action-tool'

const handlers = {
  archive: {
    input: z.object({ thought_id: requiredString('thought_id is required for archive action') }),
    run(args: ActionArgs) {
      const existing = getThoughtById(args.thought_id as string)
      if (!existing) throw new Error(`Thought '${args.thought_id}' not found`)
      if (existing.status === 'archived') {
        return existing
      }
      return archiveThoughtById(args.thought_id as string)
    }
  },

  merge: {
    input: z.object({
      source_id: requiredString('source_id is required for merge action'),
      target_id: requiredString('target_id is required for merge action')
    }),
    run(args: ActionArgs) {
      const projectFilter = resolveProjectId(args.project_id as string, args.cwd as string)
      return mergeThoughtsService({ targetId: args.target_id as string, sourceId: args.source_id as string, mergedContent: args.merged_content as string | undefined, mergedTags: args.merged_tags as string[] | undefined, projectId: projectFilter })
    }
  }
}

export function registerMemorySupersede(server: McpServer) {
  registerActionTool(server, {
    name: 'memory_supersede',
    description: `Version and supersede thoughts. Actions:
- archive: Archive a thought (set status=archived). If already archived, returns the thought unchanged (idempotent).
- merge: Merge source into target (source archived, target updated with merged content/tags)`,
    inputSchema: {
      action: z.enum(['archive', 'merge']).describe('Action'),
      thought_id: z.string().optional().describe('Thought ID (required for archive)'),
      source_id: z.string().optional().describe('REQUIRED ONLY for "merge". Source thought ID — will be archived. IGNORED for "archive".'),
      target_id: z.string().optional().describe('REQUIRED ONLY for "merge". Target thought ID — will be updated. IGNORED for "archive".'),
      merged_content: z.string().optional().describe('REQUIRED ONLY for "merge". IGNORED for "archive".'),
      merged_tags: z.array(z.string()).optional().describe('Merged tags (merge only)'),
      project_id: z.string().optional().describe('Project ID (merge only)'),
      cwd: z.string().optional().describe('Working directory — auto-resolves project (merge only)')
    },
    handlers
  })
}
