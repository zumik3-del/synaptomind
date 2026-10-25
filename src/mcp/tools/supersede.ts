import { z } from 'zod/v4'
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { NotFoundError } from '../../errors'
import {
  getThoughtByIdService,
  archiveThoughtByIdService,
  archiveThoughtsBatchService
} from '../../services/thoughts.service'
import { getBoundedMergePreviewService, mergeThoughtsService } from '../../services/merge.service'
import { createPreviewTokenService, consumePreviewTokenService } from '../../services/preview-tokens.service'
import { validateMergePreconditions } from '../../services/merge'
import { BATCH_ITEMS_MAX } from '../../validation'
import { collectionEnvelope, itemEnvelope, writeEnvelopeScope } from './envelope'
import { resolveProjectId, shapeThought } from './utils'
import { registerActionTool, requiredString, type ActionArgs } from './action-tool'

const MERGE_PREVIEW_EDGE_LIMIT = 50
const ACTION_FIELDS: Record<string, string[]> = {
  archive: ['thought_id'],
  archive_batch: ['thought_ids'],
  merge: ['source_id', 'target_id', 'merged_content', 'merged_tags', 'cwd']
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

function thoughtFingerprint(thought: { id: string; status: string; updated_at: string; is_protected: number; is_profile: number }): string {
  return `${thought.id}:${thought.status}:${thought.updated_at}:${thought.is_protected}:${thought.is_profile}`
}

const handlers = {
  archive: {
    input: z.object({ thought_id: requiredString('thought_id is required for archive action'), preview_token: z.string().optional() }),
    run(args: ActionArgs) {
      const thoughtId = args.thought_id as string
      const existing = getThoughtByIdService(thoughtId)
      const previewToken = args.preview_token as string | undefined
      if (args.confirm !== true) {
        const token = existing ? createPreviewTokenService('archive', thoughtId, thoughtFingerprint(existing as unknown as Parameters<typeof thoughtFingerprint>[0])) : undefined
        return itemEnvelope('archive', { status: 'preview', action: 'archive', thought_id: thoughtId, current_status: existing?.status ?? null,
          outcome: !existing ? 'not_found' : existing.status === 'archived' ? 'already_archived' : existing.is_profile ? 'protected' : 'would_archive',
          ...(token ? { preview_token: token } : {}) }, token ? { preview: { token } } : {})
      }
      if (!existing) throw new NotFoundError(`Thought '${thoughtId}' not found`)
      const currentFingerprint = thoughtFingerprint(existing as unknown as Parameters<typeof thoughtFingerprint>[0])
      if (!previewToken) throw new Error('preview_token is required')
      const verification = consumePreviewTokenService(previewToken, 'archive', thoughtId, currentFingerprint)
      if (!verification.valid) throw new Error(`preview token ${verification.reason ?? 'invalid'}`)
      const result = existing.status === 'archived' ? existing : archiveThoughtByIdService(thoughtId)
      return itemEnvelope('archive', { status: 'executed', action: 'archive', result: shapeThought(result) })
    }
  },

  archive_batch: {
    input: z.object({
      thought_ids: z
        .array(requiredString('each thought_ids entry must be a non-empty id'), {
          error: 'thought_ids is required for archive_batch action'
        })
        .min(1, 'thought_ids is required for archive_batch action')
        .max(BATCH_ITEMS_MAX, `thought_ids accepts at most ${BATCH_ITEMS_MAX} ids per call`),
      preview_token: z.string().optional()
    }),
    run(args: ActionArgs) {
      const ids = args.thought_ids as string[]
      const previewToken = args.preview_token as string | undefined
      if (args.confirm !== true) {
        const seen = new Set<string>()
        const items = ids.map(thought_id => {
          const duplicate = seen.has(thought_id)
          seen.add(thought_id)
          const thought = getThoughtByIdService(thought_id)
          const outcome = !thought ? 'not_found' : thought.status === 'archived' || (duplicate && !thought.is_profile) ? 'already_archived' : thought.is_profile ? 'protected' : 'would_archive'
          return { thought_id, outcome }
        })
        const fingerprint = ids.map(id => {
          const t = getThoughtByIdService(id)
          return t ? thoughtFingerprint(t as unknown as Parameters<typeof thoughtFingerprint>[0]) : `missing:${id}`
        }).join('|')
        const token = createPreviewTokenService('archive_batch', ids.join(','), fingerprint)
        // One counter per previewed outcome, so a caller sees the aggregate
        // without scanning the rows (task #2181).
        const counts: Record<string, number> = {}
        for (const item of items) counts[item.outcome] = (counts[item.outcome] ?? 0) + 1
        return collectionEnvelope('archive_batch', items, { total: ids.length, counts, preview: { token } })
      }
      const fingerprint = ids.map(id => {
        const t = getThoughtByIdService(id)
        return t ? thoughtFingerprint(t as unknown as Parameters<typeof thoughtFingerprint>[0]) : `missing:${id}`
      }).join('|')
      if (!previewToken) throw new Error('preview_token is required')
      const verification = consumePreviewTokenService(previewToken, 'archive_batch', ids.join(','), fingerprint)
      if (!verification.valid) throw new Error(`preview token ${verification.reason ?? 'invalid'}`)
      const result = archiveThoughtsBatchService(ids)
      // The service reports failures by thought id, in request order: rebuild one
      // row per requested occurrence so duplicates stay distinct.
      const failures = new Map<string, string[]>()
      for (const error of result.errors) {
        const list = failures.get(error.thought_id) ?? []
        list.push(error.error)
        failures.set(error.thought_id, list)
      }
      const items = ids.map(thought_id => {
        const error = failures.get(thought_id)?.shift()
        return error === undefined ? { thought_id, status: 'archived' as const } : { thought_id, status: 'failed' as const, error }
      })
      return collectionEnvelope('archive_batch', items, { total: ids.length, counts: { archived: result.archived, failed: result.failed } })
    }
  },

  merge: {
    input: z.object({
      source_id: requiredString('source_id is required for merge action'),
      target_id: requiredString('target_id is required for merge action'),
      preview_token: z.string().optional()
    }),
    run(args: ActionArgs) {
      const projectFilter = resolveProjectId(args.cwd as string)
      const sourceId = args.source_id as string
      const targetId = args.target_id as string
      const previewToken = args.preview_token as string | undefined
      if (args.confirm !== true) {
        const preview = getBoundedMergePreviewService(sourceId, targetId, MERGE_PREVIEW_EDGE_LIMIT)
        if (!preview) return itemEnvelope('merge', { status: 'preview', action: 'merge', source: { id: sourceId, status: null }, target: { id: targetId, status: null }, outcome: 'not_found' })
        let outcome = 'would_merge'
        let reason: string | undefined
        if (sourceId === targetId) { outcome = 'ineligible'; reason = 'source_id and target_id must be different' }
        else {
          try { validateMergePreconditions(preview.source) }
          catch (error) { outcome = 'ineligible'; reason = error instanceof Error ? error.message : String(error) }
        }
        const edgePreview = { edges: preview.source.edges, source_edge_count: preview.sourceEdgeCount, truncated: preview.sourceEdgeCount > MERGE_PREVIEW_EDGE_LIMIT }
        const token = createPreviewTokenService('merge', `${sourceId}:${targetId}`, mergeFingerprint(preview.source, preview.target, args.merged_content as string | undefined, args.merged_tags as string[] | undefined, projectFilter))
        return itemEnvelope('merge', {
          status: 'preview', action: 'merge', outcome, ...(reason ? { reason } : {}),
          source: { id: preview.source.id, status: preview.source.status, ...edgePreview },
          target: { id: preview.target.id, status: preview.target.status },
          proposed: { merged_content: args.merged_content, merged_tags: args.merged_tags, project_id: projectFilter },
          effects: { source_archived: outcome === 'would_merge', target_updated: outcome === 'would_merge' && (args.merged_content !== undefined || args.merged_tags !== undefined || projectFilter !== undefined),
            ...(outcome === 'would_merge' ? { replaces_edge_created: true } : {}) },
          preview_token: token
        }, { preview: { token }, ...writeEnvelopeScope(args.cwd) })
      }
      const source = getThoughtByIdService(sourceId)
      const target = getThoughtByIdService(targetId)
      if (source && target) {
        const currentFingerprint = mergeFingerprint(source as unknown as Parameters<typeof mergeFingerprint>[0], target as unknown as Parameters<typeof mergeFingerprint>[1], args.merged_content as string | undefined, args.merged_tags as string[] | undefined, projectFilter)
        if (!previewToken) throw new Error('preview_token is required')
        const verification = consumePreviewTokenService(previewToken, 'merge', `${sourceId}:${targetId}`, currentFingerprint)
        if (!verification.valid) throw new Error(`preview token ${verification.reason ?? 'invalid'}`)
      }
      const result = mergeThoughtsService({
        targetId,
        sourceId,
        mergedContent: args.merged_content as string | undefined,
        mergedTags: args.merged_tags as string[] | undefined,
        projectId: projectFilter
      })
      return itemEnvelope('merge', { status: 'executed', action: 'merge', result: { target: shapeThought(result.target), edges_transferred: result.transferredEdges } }, writeEnvelopeScope(args.cwd))
    }
  }
}

function mergeFingerprint(source: { id: string; content: string; tags: unknown; is_protected: number; is_profile: number; status: string; updated_at: string }, target: { id: string; content: string; tags: unknown; is_protected: number; is_profile: number; status: string; updated_at: string }, mergedContent: unknown, mergedTags: unknown, projectId: unknown): string {
  return `${source ? thoughtFingerprint(source) : 'missing'}|${target ? thoughtFingerprint(target) : 'missing'}|${JSON.stringify(mergedContent)}|${JSON.stringify(mergedTags)}|${String(projectId)}`
}

export function registerMemorySupersede(server: McpServer) {
  registerActionTool(server, {
    name: 'memory_supersede',
    description: `Version and supersede thoughts. Answers the shared envelope: { item, meta } for archive/merge, { items, meta } for archive_batch (one row per requested occurrence, aggregate in meta.counts.archived/failed); a preview sets meta.preview={token,destructive:true}. All actions preview by default; set confirm=true to execute. Actions: archive (idempotent), archive_batch (per-item partial results), merge (source→target; reports edges_transferred).`,
    inputSchema: {
      action: z.enum(['archive', 'archive_batch', 'merge']).describe('Action'),
      confirm: z.boolean().optional().describe('CONSUMED by all actions (true executes; false/omitted previews).'),
      thought_id: z.string().optional().describe('REQUIRED for "archive". Thought ID. IGNORED for "archive_batch" and "merge".'),
      thought_ids: z.array(z.string()).optional().describe('REQUIRED ONLY for "archive_batch". Thought IDs to archive in one call (1-1000); partial failures are reported per item. Rejected for other actions.'),
      source_id: z.string().optional().describe('REQUIRED ONLY for "merge". Source thought ID — will be archived. Rejected for other actions.'),
      target_id: z.string().optional().describe('REQUIRED ONLY for "merge". Target thought ID — will be updated. Rejected for other actions.'),
      merged_content: z.string().optional().describe('Replacement content for merge. OPTIONAL for "merge". REJECTED for "archive" and "archive_batch".'),
      merged_tags: z.array(z.string()).optional().describe('Merged tags. OPTIONAL for "merge". IGNORED for "archive" and "archive_batch".'),
      project_id: z.never({ error: 'project_id was removed; use cwd' }).optional().describe('Removed; use cwd.'),
      cwd: z.string().optional().describe('Working directory — auto-resolves project. OPTIONAL for "merge". IGNORED for "archive" and "archive_batch".'),
      preview_token: z.string().optional().describe('OPTIONAL preview token returned by a prior preview. CONSUMED by "archive", "archive_batch", "merge" (true executes with token validation; missing/stale fails). IGNORED for all other actions.')
    },
    handlers: Object.fromEntries(Object.entries(handlers).map(([action, handler]) => [action, {
      ...handler,
      run(args: ActionArgs) { validateActionFields(action, args); return handler.run(args) }
    }]))
  })
}