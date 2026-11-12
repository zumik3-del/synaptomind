import { z } from 'zod/v4'
import type { McpServer } from '@modelcontextprotocol/server'
import { proposalsLimitSchema } from '../../validation'
import {
  enqueueThoughtProposals,
  listPlacementProposalsService as listProposals,
  rejectPlacementProposalService as reject,
  type ListOptions
} from '../../services/placement-proposals.service'
import { isLegacyItemKind, getProposalService } from '../../services/placement-proposals.service'
import type { PlacementProposalRow } from '../../services/placement-proposals.service'
import { applyBatchService } from '../../services/placement-apply.service'
import { fingerprintOf, runGuarded } from '../../services/confirm-gate.service'
import { collectionEnvelope, itemEnvelope, readEnvelopeScope, writeEnvelopeScope } from './envelope'
import { resolveProjectId } from './utils'
import { registerActionTool, requiredString, type ActionArgs } from './action-tool'
import { applyHandler, AGENT } from './review/apply'
import { rollbackHandler } from './review/rollback'

const ITEM_KINDS = ['edge', 'placement', 'lifecycle', 'triage_activate', 'triage_archive'] as const

const handlers = {
  enqueue: {
    input: z.object({ thought_id: requiredString('thought_id is required for enqueue action') }),
    async run(args: ActionArgs) {
      const projectId = resolveProjectId(args.cwd as string | undefined)
      // `max_proposals` is the only enqueue cap this tool advertises: the
      // `max_items` alias is gone, so the canonical value is forwarded as-is
      // instead of through a precedence rule between several accepted names.
      const outcome = await enqueueThoughtProposals(args.thought_id as string, {
        projectId,
        maxProposals: args.max_proposals as number | undefined
      })
      return itemEnvelope('enqueue', outcome, {
        ...writeEnvelopeScope(args.cwd),
        counts: { proposals: outcome.proposals.length, skipped: outcome.skipped }
      })
    }
  },

  list: {
    run(args: ActionArgs) {
      // A read: the scope comes from the shared read-side helper, so a cwd-less,
      // blank or unregistered call reports a `meta.warning` instead of silently
      // spanning every project (tasks #2187, #2461).
      const { scope, warnings, projectId } = readEnvelopeScope(args.cwd)
      const includeRetired = args.include_retired === true
      const state = args.state as ListOptions['state']
      const itemKind = args.item_kind as ListOptions['itemKind']
      const sourceThoughtId = args.source_thought_id as string | undefined
      const createdAfter = args.created_after as string | undefined
      const limit = args.limit as number | undefined
      const visible = listProposals({
        state,
        itemKind,
        sourceThoughtId,
        createdAfter,
        projectId,
        limit,
        includeRetired
      })
      // Counts over the same filters (ignoring the page limit) so callers can
      // see how many retired rows were hidden by default (task #2125).
      const allVisible = listProposals({
        state,
        itemKind,
        sourceThoughtId,
        createdAfter,
        projectId,
        limit: 1000,
        includeRetired
      })
      const allMatching = listProposals({
        state,
        itemKind,
        sourceThoughtId,
        createdAfter,
        projectId,
        limit: 1000,
        includeRetired: true
      })
      const retiredCount = allMatching.filter(row => isLegacyItemKind(row.item_kind)).length
      return collectionEnvelope('list', visible, {
        scope,
        warnings,
        total: allVisible.length,
        filtered_out: allMatching.length - allVisible.length,
        counts: { retired_count: retiredCount }
      })
    }
  },

  apply: applyHandler,

  apply_batch: {
    input: z.object({
      proposal_ids: z.array(z.string()).min(1, 'proposal_ids must be a non-empty array'),
      preview_token: z.string().optional()
    }),
    async run(args: ActionArgs) {
      const proposalIds = args.proposal_ids as string[]
      const rows = proposalIds.map(id => getProposalService(id))
      const fingerprint = fingerprintOf(
        rows.map((row: PlacementProposalRow | undefined, i: number) =>
          row
            ? [
                row.id,
                row.state,
                row.fingerprint,
                row.created_at,
                row.expires_at,
                row.result,
                row.run_id
              ]
            : ['missing', proposalIds[i]]
        )
      )
      /** Rows of the batch outcome, with the per-proposal errors folded in as failed rows. */
      function envelopeFor(
        outcome: ReturnType<typeof applyBatchService>,
        previewToken?: string | null
      ) {
        const items = [
          ...outcome.results,
          ...outcome.errors.map(error => ({
            proposal_id: error.proposal_id,
            status: 'failed' as const,
            reason: error.error
          }))
        ]
        const counts: Record<string, number> = {}
        for (const item of outcome.results) counts[item.status] = (counts[item.status] ?? 0) + 1
        counts.failed = outcome.errors.length
        return collectionEnvelope('apply_batch', items, {
          total: proposalIds.length,
          counts,
          ...(outcome.refused === undefined
            ? {}
            : { warnings: [`refused (${outcome.refused.code}): ${outcome.refused.reason}`] }),
          ...(previewToken === undefined ? {} : { preview: { token: previewToken } })
        })
      }
      const runBatch = (confirm: boolean) =>
        applyBatchService(proposalIds, {
          confirm,
          runId: args.run_id as string | undefined,
          limit: args.limit as number | undefined,
          decidedBy: AGENT
        })
      const outcome = await runGuarded(args, {
        kind: 'apply_batch',
        targetId: proposalIds.join(','),
        fingerprint: () => fingerprint,
        preview: () => runBatch(false),
        apply: () => runBatch(true)
      })
      return outcome.status === 'preview'
        ? envelopeFor(outcome.value, outcome.token)
        : envelopeFor(outcome.value)
    }
  },

  rollback: rollbackHandler,

  reject: {
    input: z.object({ proposal_id: requiredString('proposal_id is required for reject action') }),
    run(args: ActionArgs) {
      return itemEnvelope('reject', reject(args.proposal_id as string, { decidedBy: AGENT }))
    }
  }
}

export function registerEdgeReview(server: McpServer) {
  registerActionTool(server, {
    name: 'edge_review',
    description: `Review and apply placement proposals. Answers the shared envelope: { items, meta } for list/apply_batch/rollback (aggregate in meta.counts), { item, meta } for enqueue/apply/reject; a preview sets meta.preview={token,destructive:true}. Actions: enqueue (persisted thought only; queues the plan's edge items and reports the skipped ones), list (default pending), apply (dry-run unless confirm=true), apply_batch (per-call cap), rollback (dry-run; one items row per proposal of the run), reject. Rows of a retired item kind (triage_*) stay listable but cannot be applied.`,
    inputSchema: {
      action: z
        .enum(['enqueue', 'list', 'apply', 'apply_batch', 'rollback', 'reject'])
        .describe('Action'),
      thought_id: z
        .string()
        .optional()
        .describe(
          'REQUIRED for "enqueue": persisted thought whose proposals are queued (create the thought first; drafts are not enqueued). IGNORED for all other actions.'
        ),
      max_proposals: z
        .number()
        .int()
        .min(1)
        .optional()
        .describe(
          'Cap on the number of proposals generated for this thought (the only enqueue cap; default placement.maxProposalsPerEnqueue). OPTIONAL for "enqueue". IGNORED for all other actions.'
        ),
      proposal_id: z
        .string()
        .optional()
        .describe(
          'REQUIRED for "apply" and "reject": queued proposal id. IGNORED for all other actions.'
        ),
      proposal_ids: z
        .array(z.string())
        .optional()
        .describe(
          'REQUIRED for "apply_batch": queued proposal ids. IGNORED for all other actions.'
        ),
      run_id: z
        .string()
        .optional()
        .describe(
          'Run envelope: REQUIRED for "rollback". It groups the rows one rollback can reverse. An un-enveloped apply/apply_batch gets a synthesized "auto-" + UUIDv7 envelope, returned as run_id on the accepted result (apply) and on the batch outcome (apply_batch), so it is rollback-addressable. "rollback" refuses any row decided more than placement.proposalTtlDays (default 30) days before the server\'s own clock; no public surface accepts a caller-supplied clock. The cutoff is inclusive: a row decided exactly at the boundary is still reversible, and a negative proposalTtlDays disables the window entirely'
        ),
      confirm: z
        .boolean()
        .optional()
        .describe(
          'CONSUMED by "apply", "apply_batch", "rollback" (true executes; false/omitted previews). IGNORED for "enqueue", "list", "reject".'
        ),
      preview_token: z
        .string()
        .optional()
        .describe(
          'OPTIONAL preview token returned by a prior preview. CONSUMED by "apply", "apply_batch", "rollback" (true executes with token validation; missing/stale fails). IGNORED for "enqueue", "list", "reject".'
        ),
      state: z
        .enum(['pending', 'accepted', 'rejected', 'expired', 'stale', 'rolled_back'])
        .optional()
        .describe(
          'State filter (default pending). OPTIONAL for "list". IGNORED for all other actions.'
        ),
      item_kind: z
        .enum(ITEM_KINDS)
        .optional()
        .describe('Item-kind filter (edge). OPTIONAL for "list". IGNORED for all other actions.'),
      include_retired: z
        .boolean()
        .optional()
        .describe(
          'When true, retired (legacy) kinds (triage_*, placement, lifecycle) are included in "list" even without an explicit item_kind. Default false. OPTIONAL for "list". IGNORED for all other actions.'
        ),
      source_thought_id: z
        .string()
        .optional()
        .describe(
          'Filter queued proposals by source thought id. OPTIONAL for "list". IGNORED for all other actions.'
        ),
      created_after: z.iso
        .datetime()
        .optional()
        .describe(
          'Only proposals created at or after this ISO timestamp (UTC, e.g. 2026-01-01T00:00:00.000Z). OPTIONAL for "list". IGNORED for all other actions.'
        ),
      project_id: z
        .never({ error: 'project_id was removed; use cwd' })
        .optional()
        .describe('Removed; use cwd.'),
      cwd: z
        .string()
        .optional()
        .describe(
          'Working directory — auto-resolves project. OPTIONAL for "enqueue" and "list". IGNORED for "apply", "apply_batch", "rollback", "reject".'
        ),
      limit: proposalsLimitSchema
        .optional()
        .describe(
          'Max rows (default 100, 1-1000) for "list"; max items for "apply_batch". OPTIONAL for "list" and "apply_batch". IGNORED for all other actions.'
        ),
      // Tombstone for the retired enqueue cap: only max_proposals is advertised.
      max_items: z
        .never({ error: 'max_items was removed; use max_proposals' })
        .optional()
        .describe('Removed; use max_proposals.')
    },
    handlers
  })
}
