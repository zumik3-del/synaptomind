import { z } from 'zod/v4'
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { NotFoundError } from '../../errors'
import {
  getThoughtByIdService,
  archiveThoughtByIdService,
  archiveThoughtsBatchService
} from '../../services/thoughts.service'
import { mergeThoughtsService } from '../../services/merge.service'
import { BATCH_ITEMS_MAX } from '../../validation'
import { resolveProjectId } from './utils'
import { registerActionTool, requiredString, type ActionArgs } from './action-tool'

const handlers = {
  archive: {
    input: z.object({ thought_id: requiredString('thought_id is required for archive action') }),
    run(args: ActionArgs) {
      const existing = getThoughtByIdService(args.thought_id as string)
      if (!existing) throw new NotFoundError(`Thought '${args.thought_id}' not found`)
      if (existing.status === 'archived') {
        return existing
      }
      return archiveThoughtByIdService(args.thought_id as string)
    }
  },

  archive_batch: {
    input: z.object({
      thought_ids: z
        .array(requiredString('each thought_ids entry must be a non-empty id'), {
          error: 'thought_ids is required for archive_batch action'
        })
        .min(1, 'thought_ids is required for archive_batch action')
        .max(BATCH_ITEMS_MAX, `thought_ids accepts at most ${BATCH_ITEMS_MAX} ids per call`)
    }),
    run(args: ActionArgs) {
      return archiveThoughtsBatchService(args.thought_ids as string[])
    }
  },

  merge: {
    input: z.object({
      source_id: requiredString('source_id is required for merge action'),
      target_id: requiredString('target_id is required for merge action')
    }),
    run(args: ActionArgs) {
      const projectFilter = resolveProjectId(args.project_id as string, args.cwd as string)
      const result = mergeThoughtsService({
        targetId: args.target_id as string,
        sourceId: args.source_id as string,
        mergedContent: args.merged_content as string | undefined,
        mergedTags: args.merged_tags as string[] | undefined,
        projectId: projectFilter
      })
      // The MCP surface reports the consolidation in snake_case (`edges_transferred`);
      // the HTTP twin keeps its long-standing `transferredEdges` field, so the service
      // result is renamed here instead of at the writer.
      return { target: result.target, edges_transferred: result.transferredEdges }
    }
  }
}

export function registerMemorySupersede(server: McpServer) {
  registerActionTool(server, {
    name: 'memory_supersede',
    description: `Version and supersede thoughts. Actions: archive (idempotent, preview→confirm), archive_batch (one transaction, per-item results), merge (source→target; reports edges_transferred; preview→confirm).`,
    inputSchema: {
      action: z.enum(['archive', 'archive_batch', 'merge']).describe('Action'),
      thought_id: z.string().optional().describe('Thought ID (required for archive)'),
      thought_ids: z.array(z.string()).optional().describe('REQUIRED ONLY for "archive_batch". Thought IDs to archive in one call (1-1000); partial failures are reported per item. IGNORED for "archive" and "merge".'),
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
