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
import { guardedCollectionEnvelope, guardedEnvelope, writeEnvelopeScope } from './envelope'
import { shapeEntity } from './utils'
import {
  DESTRUCTIVE,
  actionInput,
  registerActionTool,
  requiredString,
  type ActionArgs
} from './action-tool'

const MERGE_PREVIEW_EDGE_LIMIT = 50

const SUPERSEDE_ARGS = {
  confirm: z
    .boolean()
    .optional()
    .describe('CONSUMED by all actions (true executes; false/omitted previews).'),
  thought_id: z
    .string()
    .optional()
    .describe('REQUIRED for "archive". Thought ID. REJECTED for "archive_batch" and "merge".'),
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
    .describe('Merged tags. OPTIONAL for "merge". REJECTED for "archive" and "archive_batch".'),
  project_id: z
    .never({ error: 'project_id was removed; there is no project argument' })
    .optional()
    .describe('Removed; there is no project argument.'),
  cwd: z
    .string()
    .optional()
    .describe(
      'Working directory — resolves the project scope the answer reports in meta.scope; a "merge" changes no thought\'s project. OPTIONAL for "merge". ACCEPTED AND IGNORED for "archive" and "archive_batch".'
    ),
  preview_token: z
    .string()
    .optional()
    .describe(
      'OPTIONAL preview token returned by a prior preview. CONSUMED by "archive", "archive_batch", "merge" (true executes with token validation; missing/stale fails). REJECTED for all other actions.'
    )
}

const handlers = {
  archive: {
    input: actionInput(SUPERSEDE_ARGS, ['thought_id', 'confirm', 'preview_token'], {
      thought_id: requiredString('thought_id is required for archive action')
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
        preview: () => ({
          status: 'preview',
          action: 'archive',
          thought_id: thoughtId,
          current_status: existing?.status ?? null,
          outcome: !existing
            ? 'not_found'
            : existing.status === 'archived'
              ? 'already_archived'
              : 'would_archive'
        }),
        apply: () => {
          if (!existing) throw new NotFoundError(`Thought '${thoughtId}' not found`)
          const result =
            existing.status === 'archived' ? existing : archiveThoughtByIdService(thoughtId)
          return {
            status: 'executed',
            action: 'archive',
            result: shapeEntity(result)
          }
        }
      })
      return guardedEnvelope('archive', outcome)
    }
  },

  archive_batch: {
    input: actionInput(SUPERSEDE_ARGS, ['thought_ids', 'confirm', 'preview_token'], {
      thought_ids: z
        .array(requiredString('each thought_ids entry must be a non-empty id'), {
          error: 'thought_ids is required for archive_batch action'
        })
        .min(1, 'thought_ids is required for archive_batch action')
        .max(BATCH_ITEMS_MAX, `thought_ids accepts at most ${BATCH_ITEMS_MAX} ids per call`)
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
        preview: () => {
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
          return { items, counts }
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
          return { items, counts: { archived: result.archived, failed: result.failed } }
        }
      })
      const report = outcome.value
      return guardedCollectionEnvelope('archive_batch', outcome, {
        total: ids.length,
        counts: report.counts
      })
    }
  },

  merge: {
    input: actionInput(
      SUPERSEDE_ARGS,
      ['source_id', 'target_id', 'merged_content', 'merged_tags', 'confirm', 'preview_token'],
      {
        source_id: requiredString('source_id is required for merge action'),
        target_id: requiredString('target_id is required for merge action')
      }
    ),
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
        preview: () => {
          const preview = getBoundedMergePreviewService(
            sourceId,
            targetId,
            MERGE_PREVIEW_EDGE_LIMIT
          )
          if (!preview)
            return {
              status: 'preview',
              action: 'merge',
              source: { id: sourceId, status: null },
              target: { id: targetId, status: null },
              outcome: 'not_found'
            }
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
          return {
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
            }
          }
        },
        apply: () => {
          // Id-addressed write: the target keeps its own project; cwd only scopes the answer.
          const result = mergeThoughtsService({
            targetId,
            sourceId,
            mergedContent,
            mergedTags
          })
          return {
            status: 'executed',
            action: 'merge',
            result: {
              target: shapeEntity(result.target),
              edges_transferred: result.transferredEdges
            }
          }
        }
      })
      return guardedEnvelope('merge', outcome, writeEnvelopeScope(args.cwd))
    }
  }
}

export function registerMemorySupersede(server: McpServer) {
  registerActionTool(server, {
    name: 'memory_supersede',
    annotations: DESTRUCTIVE,
    description: `Retire a thought without deleting it: archive one, archive a batch, or merge one thought onto another and transfer its edges. Reading is memory_recall, creating and linking memory_store, permanent removal memory_retention. Actions: archive (idempotent), archive_batch (one row per requested occurrence), merge (source→target, reports edges_transferred). All actions preview by default and set meta.preview={token,destructive:true}; confirm=true executes after revalidating state. Answers { item, meta } for archive and merge, { items, meta } for archive_batch with the aggregate in meta.counts.archived/failed.`,
    inputSchema: {
      action: z.enum(['archive', 'archive_batch', 'merge']).describe('Action'),
      ...SUPERSEDE_ARGS
    },
    handlers
  })
}
