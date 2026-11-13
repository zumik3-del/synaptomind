import { z } from 'zod/v4'
import type { McpServer } from '@modelcontextprotocol/server'
import { NotFoundError } from '../../errors'
import {
  getThoughtByIdService,
  archiveThoughtByIdService,
  archiveThoughtsBatchService
} from '../../services/thoughts.service'
import { getBoundedMergePreviewService, mergeThoughtsService } from '../../services/merge.service'
import { fingerprintOf, runGuarded } from '../../services/confirm-gate.service'
import { validateMergePreconditions } from '../../services/merge-helpers.service'
import { BATCH_ITEMS_MAX } from '../../validation'
import { collectionEnvelope, itemEnvelope, writeEnvelopeScope } from './envelope'
import { shapeThought } from './utils'
import { registerActionTool, requiredString, type ActionArgs } from './action-tool'
import {
  allActionFields,
  validateActionFields as validateSharedActionFields
} from './action-fields'

const MERGE_PREVIEW_EDGE_LIMIT = 50
const ACTION_FIELDS: Record<string, string[]> = {
  archive: ['thought_id'],
  archive_batch: ['thought_ids'],
  merge: ['source_id', 'target_id', 'merged_content', 'merged_tags', 'cwd']
}
const ACTION_FIELDS_ALL = allActionFields(ACTION_FIELDS)

function validateActionFields(action: string, args: ActionArgs): void {
  if (args.confirm !== undefined && typeof args.confirm !== 'boolean') {
    throw new Error('confirm must be a boolean (true to execute; false or omitted to preview)')
  }
  validateSharedActionFields(action, args, ACTION_FIELDS, ACTION_FIELDS_ALL)
}

const handlers = {
  archive: {
    input: z.object({
      thought_id: requiredString('thought_id is required for archive action'),
      preview_token: z.string().optional()
    }),
    async run(args: ActionArgs) {
      const thoughtId = args.thought_id as string
      const existing = getThoughtByIdService(thoughtId)
      const outcome = await runGuarded(args, {
        kind: 'archive',
        targetId: thoughtId,
        fingerprint: () =>
          existing
            ? fingerprintOf(
                existing.id,
                existing.status,
                existing.updated_at,
                existing.is_protected
              )
            : null,
        preview: token =>
          itemEnvelope(
            'archive',
            {
              status: 'preview',
              action: 'archive',
              thought_id: thoughtId,
              current_status: existing?.status ?? null,
              outcome: !existing
                ? 'not_found'
                : existing.status === 'archived'
                  ? 'already_archived'
                  : 'would_archive',
              ...(token === null ? {} : { preview_token: token })
            },
            token === null ? {} : { preview: { token } }
          ),
        apply: () => {
          if (!existing) throw new NotFoundError(`Thought '${thoughtId}' not found`)
          const result =
            existing.status === 'archived' ? existing : archiveThoughtByIdService(thoughtId)
          return itemEnvelope('archive', {
            status: 'executed',
            action: 'archive',
            result: shapeThought(result)
          })
        }
      })
      return outcome.value
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
    async run(args: ActionArgs) {
      const ids = args.thought_ids as string[]
      const thoughts = ids.map(thought_id => getThoughtByIdService(thought_id))
      const outcome = await runGuarded(args, {
        kind: 'archive_batch',
        targetId: ids.join(','),
        fingerprint: () =>
          fingerprintOf(
            thoughts.map((thought, i) =>
              thought
                ? [thought.id, thought.status, thought.updated_at, thought.is_protected]
                : ['missing', ids[i]]
            )
          ),
        preview: token => {
          const seen = new Set<string>()
          const items = ids.map((thought_id, i) => {
            const duplicate = seen.has(thought_id)
            seen.add(thought_id)
            const thought = thoughts[i]
            const outcome = !thought
              ? 'not_found'
              : thought.status === 'archived' || duplicate
                ? 'already_archived'
                : 'would_archive'
            return { thought_id, outcome }
          })
          const counts: Record<string, number> = {}
          for (const item of items) counts[item.outcome] = (counts[item.outcome] ?? 0) + 1
          return collectionEnvelope('archive_batch', items, {
            total: ids.length,
            counts,
            preview: { token }
          })
        },
        apply: () => {
          const result = archiveThoughtsBatchService(ids)
          const failures = new Map<string, string[]>()
          for (const error of result.errors) {
            const list = failures.get(error.thought_id) ?? []
            list.push(error.error)
            failures.set(error.thought_id, list)
          }
          const items = ids.map(thought_id => {
            const error = failures.get(thought_id)?.shift()
            return error === undefined
              ? { thought_id, status: 'archived' as const }
              : { thought_id, status: 'failed' as const, error }
          })
          return collectionEnvelope('archive_batch', items, {
            total: ids.length,
            counts: { archived: result.archived, failed: result.failed }
          })
        }
      })
      return outcome.value
    }
  },

  merge: {
    input: z.object({
      source_id: requiredString('source_id is required for merge action'),
      target_id: requiredString('target_id is required for merge action'),
      preview_token: z.string().optional()
    }),
    async run(args: ActionArgs) {
      const sourceId = args.source_id as string
      const targetId = args.target_id as string
      const mergedContent = args.merged_content as string | undefined
      const mergedTags = args.merged_tags as string[] | undefined
      const source = getThoughtByIdService(sourceId)
      const target = getThoughtByIdService(targetId)
      const outcome = await runGuarded(args, {
        kind: 'merge',
        targetId: `${sourceId}:${targetId}`,
        fingerprint: () =>
          source && target
            ? fingerprintOf(
                [source.id, source.status, source.updated_at, source.is_protected],
                [target.id, target.status, target.updated_at, target.is_protected],
                mergedContent,
                mergedTags
              )
            : null,
        preview: token => {
          const preview = getBoundedMergePreviewService(
            sourceId,
            targetId,
            MERGE_PREVIEW_EDGE_LIMIT
          )
          if (!preview)
            return itemEnvelope('merge', {
              status: 'preview',
              action: 'merge',
              source: { id: sourceId, status: null },
              target: { id: targetId, status: null },
              outcome: 'not_found'
            })
          let mergeOutcome = 'would_merge'
          let reason: string | undefined
          if (sourceId === targetId) {
            mergeOutcome = 'ineligible'
            reason = 'source_id and target_id must be different'
          } else {
            try {
              validateMergePreconditions(preview.source)
            } catch (error) {
              mergeOutcome = 'ineligible'
              reason = error instanceof Error ? error.message : String(error)
            }
          }
          const edgePreview = {
            edges: preview.source.edges,
            source_edge_count: preview.sourceEdgeCount,
            truncated: preview.sourceEdgeCount > MERGE_PREVIEW_EDGE_LIMIT
          }
          return itemEnvelope(
            'merge',
            {
              status: 'preview',
              action: 'merge',
              outcome: mergeOutcome,
              ...(reason ? { reason } : {}),
              source: { id: preview.source.id, status: preview.source.status, ...edgePreview },
              target: { id: preview.target.id, status: preview.target.status },
              proposed: {
                merged_content: mergedContent,
                merged_tags: mergedTags
              },
              effects: {
                source_archived: mergeOutcome === 'would_merge',
                target_updated:
                  mergeOutcome === 'would_merge' &&
                  (mergedContent !== undefined || mergedTags !== undefined),
                ...(mergeOutcome === 'would_merge' ? { replaces_edge_created: true } : {})
              },
              ...(token === null ? {} : { preview_token: token })
            },
            { ...(token === null ? {} : { preview: { token } }), ...writeEnvelopeScope(args.cwd) }
          )
        },
        apply: () => {
          // Id-addressed write: the target keeps its own project; cwd only scopes the answer.
          const result = mergeThoughtsService({
            targetId,
            sourceId,
            mergedContent,
            mergedTags
          })
          return itemEnvelope(
            'merge',
            {
              status: 'executed',
              action: 'merge',
              result: {
                target: shapeThought(result.target),
                edges_transferred: result.transferredEdges
              }
            },
            writeEnvelopeScope(args.cwd)
          )
        }
      })
      return outcome.value
    }
  }
}

export function registerMemorySupersede(server: McpServer) {
  registerActionTool(server, {
    name: 'memory_supersede',
    description: `Version and supersede thoughts. Answers the shared envelope: { item, meta } for archive/merge, { items, meta } for archive_batch (one row per requested occurrence, aggregate in meta.counts.archived/failed); a preview sets meta.preview={token,destructive:true}. All actions preview by default; set confirm=true to execute. Actions: archive (idempotent), archive_batch (per-item partial results), merge (source→target; reports edges_transferred).`,
    inputSchema: {
      action: z.enum(['archive', 'archive_batch', 'merge']).describe('Action'),
      confirm: z
        .boolean()
        .optional()
        .describe('CONSUMED by all actions (true executes; false/omitted previews).'),
      thought_id: z
        .string()
        .optional()
        .describe('REQUIRED for "archive". Thought ID. IGNORED for "archive_batch" and "merge".'),
      thought_ids: z
        .array(z.string())
        .optional()
        .describe(
          'REQUIRED ONLY for "archive_batch". Thought IDs to archive in one call (1-1000); partial failures are reported per item. Rejected for other actions.'
        ),
      source_id: z
        .string()
        .optional()
        .describe(
          'REQUIRED ONLY for "merge". Source thought ID — will be archived. Rejected for other actions.'
        ),
      target_id: z
        .string()
        .optional()
        .describe(
          'REQUIRED ONLY for "merge". Target thought ID — will be updated. Rejected for other actions.'
        ),
      merged_content: z
        .string()
        .optional()
        .describe(
          'Replacement content for merge. OPTIONAL for "merge". REJECTED for "archive" and "archive_batch".'
        ),
      merged_tags: z
        .array(z.string())
        .optional()
        .describe('Merged tags. OPTIONAL for "merge". IGNORED for "archive" and "archive_batch".'),
      project_id: z
        .never({ error: 'project_id was removed; use cwd' })
        .optional()
        .describe('Removed; use cwd.'),
      cwd: z
        .string()
        .optional()
        .describe(
          'Working directory — resolves the project scope reported in meta.scope; merge never changes the addressed thoughts\' project. OPTIONAL for "merge". IGNORED for "archive" and "archive_batch".'
        ),
      preview_token: z
        .string()
        .optional()
        .describe(
          'OPTIONAL preview token returned by a prior preview. CONSUMED by "archive", "archive_batch", "merge" (true executes with token validation; missing/stale fails). IGNORED for all other actions.'
        )
    },
    handlers: Object.fromEntries(
      Object.entries(handlers).map(([action, handler]) => [
        action,
        {
          ...handler,
          run(args: ActionArgs) {
            validateActionFields(action, args)
            return handler.run(args)
          }
        }
      ])
    )
  })
}
