import { z } from 'zod/v4'
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { NotFoundError } from '../../errors'
import {
  getThoughtByIdService,
  archiveThoughtByIdService,
  archiveThoughtsBatchService
} from '../../services/thoughts.service'
import { getBoundedMergePreviewService, mergeThoughtsService } from '../../services/merge.service'
import { validateMergePreconditions } from '../../services/merge'
import { BATCH_ITEMS_MAX } from '../../validation'
import { resolveProjectId } from './utils'
import { registerActionTool, requiredString, type ActionArgs } from './action-tool'

const MERGE_PREVIEW_EDGE_LIMIT = 50
const ACTION_FIELDS: Record<string, string[]> = {
  archive: ['thought_id'],
  archive_batch: ['thought_ids'],
  merge: ['source_id', 'target_id', 'merged_content', 'merged_tags', 'project_id', 'cwd']
}
const ACTION_FIELDS_ALL = new Set(Object.values(ACTION_FIELDS).flat())

function validateActionFields(action: string, args: ActionArgs): void {
  if (args.confirm !== undefined && typeof args.confirm !== 'boolean') {
    throw new Error('confirm must be a boolean (true to execute; false or omitted to preview)')
  }
  const allowed = new Set(ACTION_FIELDS[action] ?? [])
  const irrelevant = Object.keys(args).filter(key => ACTION_FIELDS_ALL.has(key) && !allowed.has(key))
  if (irrelevant.length) throw new Error(`${irrelevant.join(', ')} is not applicable to ${action} action`)
}

const handlers = {
  archive: {
    input: z.object({ thought_id: requiredString('thought_id is required for archive action') }),
    run(args: ActionArgs) {
      const existing = getThoughtByIdService(args.thought_id as string)
      if (args.confirm !== true) {
        return { status: 'preview', action: 'archive', thought_id: args.thought_id, current_status: existing?.status ?? null,
          outcome: !existing ? 'not_found' : existing.status === 'archived' ? 'already_archived' : existing.is_profile ? 'protected' : 'would_archive' }
      }
      if (!existing) throw new NotFoundError(`Thought '${args.thought_id}' not found`)
      const result = existing.status === 'archived' ? existing : archiveThoughtByIdService(args.thought_id as string)
      return { status: 'executed', action: 'archive', result }
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
      const ids = args.thought_ids as string[]
      if (args.confirm !== true) {
        const seen = new Set<string>()
        const items = ids.map(thought_id => {
          const duplicate = seen.has(thought_id)
          seen.add(thought_id)
          const thought = getThoughtByIdService(thought_id)
          const outcome = !thought ? 'not_found' : thought.status === 'archived' || (duplicate && !thought.is_profile) ? 'already_archived' : thought.is_profile ? 'protected' : 'would_archive'
          return { thought_id, outcome }
        })
        return { status: 'preview', action: 'archive_batch', requested_count: ids.length, items }
      }
      return { status: 'executed', action: 'archive_batch', result: archiveThoughtsBatchService(ids) }
    }
  },

  merge: {
    input: z.object({
      source_id: requiredString('source_id is required for merge action'),
      target_id: requiredString('target_id is required for merge action')
    }),
    run(args: ActionArgs) {
      const projectFilter = resolveProjectId(args.project_id as string, args.cwd as string)
      if (args.confirm !== true) {
        const preview = getBoundedMergePreviewService(args.source_id as string, args.target_id as string, MERGE_PREVIEW_EDGE_LIMIT)
        if (!preview) return { status: 'preview', action: 'merge', source: { id: args.source_id, status: null }, target: { id: args.target_id, status: null }, outcome: 'not_found' }
        let outcome = 'would_merge'
        let reason: string | undefined
        if (args.source_id === args.target_id) { outcome = 'ineligible'; reason = 'source_id and target_id must be different' }
        else {
          try { validateMergePreconditions(preview.source) }
          catch (error) { outcome = 'ineligible'; reason = error instanceof Error ? error.message : String(error) }
        }
        const edgePreview = { edges: preview.source.edges, source_edge_count: preview.sourceEdgeCount, truncated: preview.sourceEdgeCount > MERGE_PREVIEW_EDGE_LIMIT }
        return {
          status: 'preview', action: 'merge', outcome, ...(reason ? { reason } : {}),
          source: { id: preview.source.id, status: preview.source.status, ...edgePreview },
          target: { id: preview.target.id, status: preview.target.status },
          proposed: { merged_content: args.merged_content, merged_tags: args.merged_tags, project_id: projectFilter },
          effects: { source_archived: outcome === 'would_merge', target_updated: outcome === 'would_merge' && (args.merged_content !== undefined || args.merged_tags !== undefined || projectFilter !== undefined),
            ...(outcome === 'would_merge' ? { replaces_edge_created: true } : {}) }
        }
      }
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
      return { status: 'executed', action: 'merge', result: { target: result.target, edges_transferred: result.transferredEdges } }
    }
  }
}

export function registerMemorySupersede(server: McpServer) {
  registerActionTool(server, {
    name: 'memory_supersede',
    description: `Version and supersede thoughts. All actions preview by default; set confirm=true to execute. Actions: archive (idempotent), archive_batch (per-item partial results), merge (source→target; reports edges_transferred).`,
    inputSchema: {
      action: z.enum(['archive', 'archive_batch', 'merge']).describe('Action'),
      confirm: z.boolean().optional().describe('CONSUMED by all actions (true executes; false/omitted previews).'),
      thought_id: z.string().optional().describe('REQUIRED for "archive". Thought ID. IGNORED for "archive_batch" and "merge".'),
      thought_ids: z.array(z.string()).optional().describe('REQUIRED ONLY for "archive_batch". Thought IDs to archive in one call (1-1000); partial failures are reported per item. Rejected for other actions.'),
      source_id: z.string().optional().describe('REQUIRED ONLY for "merge". Source thought ID — will be archived. Rejected for other actions.'),
      target_id: z.string().optional().describe('REQUIRED ONLY for "merge". Target thought ID — will be updated. Rejected for other actions.'),
      merged_content: z.string().optional().describe('Replacement content for merge. OPTIONAL for "merge". REJECTED for "archive" and "archive_batch".'),
      merged_tags: z.array(z.string()).optional().describe('Merged tags. OPTIONAL for "merge". IGNORED for "archive" and "archive_batch".'),
      project_id: z.string().optional().describe('Project ID. OPTIONAL for "merge". IGNORED for "archive" and "archive_batch".'),
      cwd: z.string().optional().describe('Working directory — auto-resolves project. OPTIONAL for "merge". IGNORED for "archive" and "archive_batch".')
    },
    handlers: Object.fromEntries(Object.entries(handlers).map(([action, handler]) => [action, {
      ...handler,
      run(args: ActionArgs) { validateActionFields(action, args); return handler.run(args) }
    }]))
  })
}
