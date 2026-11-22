import { z } from 'zod/v4'
import type { McpServer } from '@modelcontextprotocol/server'
import {
  enqueueThoughtProposals,
  listPlacementProposalsPageService as listProposalsPage,
  rejectPlacementProposalService as reject,
  type ListOptions
} from '../../services/placement-proposals.service'
import { getProposalService } from '../../services/placement-proposals.service'
import type { PlacementProposalRow } from '../../services/placement-proposals.service'
import { applyBatchService } from '../../services/placement-apply.service'
import { fingerprintOf, runGuarded } from '../../services/confirm-gate.service'
import { collectionEnvelope, itemEnvelope, readEnvelopeScope, writeEnvelopeScope } from './envelope'
import { resolveProjectId } from './utils'
import { actionInput, registerActionTool, requiredString, type ActionArgs } from './action-tool'
import { applyHandler, AGENT } from './review/apply'
import { rollbackHandler } from './review/rollback'
import { REVIEW_ARGS } from './review/args'

const handlers = {
  enqueue: {
    input: actionInput(REVIEW_ARGS, ['thought_id', 'max_proposals'], {
      thought_id: requiredString('thought_id is required for enqueue action')
    }),
    async run(args: ActionArgs) {
      const projectId = resolveProjectId(args.cwd as string | undefined)
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
    input: actionInput(REVIEW_ARGS, [
      'state',
      'item_kind',
      'source_thought_id',
      'created_after',
      'include_retired',
      'limit'
    ]),
    run(args: ActionArgs) {
      const { scope, warnings, projectId } = readEnvelopeScope(args.cwd)
      const filters: ListOptions = {
        state: args.state as ListOptions['state'],
        itemKind: args.item_kind as ListOptions['itemKind'],
        sourceThoughtId: args.source_thought_id as string | undefined,
        createdAfter: args.created_after as string | undefined,
        projectId,
        now: new Date().toISOString()
      }
      const page = listProposalsPage({
        ...filters,
        includeRetired: args.include_retired === true,
        limit: args.limit as number | undefined
      })
      return collectionEnvelope('list', page.items, {
        scope,
        warnings,
        total: page.total,
        filtered_out: Math.max(0, page.total - page.items.length),
        counts: { retired_count: page.hiddenRetired }
      })
    }
  },

  apply: applyHandler,

  apply_batch: {
    input: actionInput(
      REVIEW_ARGS,
      ['proposal_ids', 'run_id', 'confirm', 'preview_token', 'limit'],
      {
        proposal_ids: z.array(z.string()).min(1, 'proposal_ids must be a non-empty array')
      }
    ),
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
    input: actionInput(REVIEW_ARGS, ['proposal_id'], {
      proposal_id: requiredString('proposal_id is required for reject action')
    }),
    run(args: ActionArgs) {
      return itemEnvelope('reject', reject(args.proposal_id as string, { decidedBy: AGENT }))
    }
  }
}

export function registerEdgeReview(server: McpServer) {
  registerActionTool(server, {
    name: 'edge_review',
    description: `Review and apply placement proposals. Answers the shared envelope: { items, meta } for list/apply_batch/rollback (aggregate in meta.counts), { item, meta } for enqueue/apply/reject; a preview sets meta.preview={token,destructive:true}. Actions: enqueue (persisted thought only; queues the plan's edge items and reports the skipped ones), list (default pending; page and counts.total apply the same filters in SQL — pending liveness and, unless include_retired, the retired-kind exclusion — so counts.total is the un-paged row count, counts.filtered_out the rows the page limit left out and counts.retired_count the retired rows the default filter hid), apply (dry-run unless confirm=true), apply_batch (per-call cap), rollback (dry-run; one items row per proposal of the run), reject. Rows of a retired item kind (triage_*) stay listable but cannot be applied. Every action refuses an argument that belongs to another one.`,
    inputSchema: {
      action: z
        .enum(['enqueue', 'list', 'apply', 'apply_batch', 'rollback', 'reject'])
        .describe('Action'),
      ...REVIEW_ARGS
    },
    handlers
  })
}
