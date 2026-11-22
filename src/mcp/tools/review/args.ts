import { z } from 'zod/v4'
import { proposalsLimitSchema } from '../../../validation'

const ITEM_KINDS = ['edge', 'placement', 'lifecycle', 'triage_activate', 'triage_archive'] as const

export const REVIEW_ARGS = {
  thought_id: z
    .string()
    .optional()
    .describe(
      'REQUIRED for "enqueue": persisted thought whose proposals are queued (create the thought first; drafts are not enqueued). REJECTED for all other actions.'
    ),
  max_proposals: z.coerce
    .number()
    .int()
    .min(1)
    .optional()
    .describe(
      'Cap on the number of proposals generated for this thought (the only enqueue cap; default placement.maxProposalsPerEnqueue). OPTIONAL for "enqueue". REJECTED for all other actions.'
    ),
  proposal_id: z
    .string()
    .optional()
    .describe(
      'REQUIRED for "apply" and "reject": queued proposal id. REJECTED for all other actions.'
    ),
  proposal_ids: z
    .array(z.string())
    .optional()
    .describe('REQUIRED for "apply_batch": queued proposal ids. REJECTED for all other actions.'),
  run_id: z
    .string()
    .optional()
    .describe(
      'Run envelope: REQUIRED for "rollback". It groups the rows one rollback can reverse. An un-enveloped apply/apply_batch gets a synthesized "auto-" + UUIDv7 envelope, returned as run_id on the accepted result (apply) and on the batch outcome (apply_batch), so it is rollback-addressable. OPTIONAL for "apply" and "apply_batch" (pass it to group several applies into one envelope). "rollback" refuses any row decided more than placement.proposalTtlDays (default 30) days before the server\'s own clock; no public surface accepts a caller-supplied clock. The cutoff is inclusive: a row decided exactly at the boundary is still reversible, and a negative proposalTtlDays disables the window entirely. REJECTED for "enqueue", "list", "reject".'
    ),
  confirm: z
    .boolean()
    .optional()
    .describe(
      'CONSUMED by "apply", "apply_batch", "rollback" (true executes; false/omitted previews). REJECTED for "enqueue", "list", "reject".'
    ),
  preview_token: z
    .string()
    .optional()
    .describe(
      'OPTIONAL preview token returned by a prior preview. CONSUMED by "apply", "apply_batch", "rollback" (true executes with token validation; missing/stale fails). REJECTED for "enqueue", "list", "reject".'
    ),
  state: z
    .enum(['pending', 'accepted', 'rejected', 'expired', 'stale', 'rolled_back'])
    .optional()
    .describe(
      'State filter (default pending). OPTIONAL for "list". REJECTED for all other actions.'
    ),
  item_kind: z
    .enum(ITEM_KINDS)
    .optional()
    .describe('Item-kind filter (edge). OPTIONAL for "list". REJECTED for all other actions.'),
  include_retired: z
    .boolean()
    .optional()
    .describe(
      'When true, retired (legacy) kinds (triage_*, placement, lifecycle) are included in "list" even without an explicit item_kind. Default false. OPTIONAL for "list". REJECTED for all other actions.'
    ),
  source_thought_id: z
    .string()
    .optional()
    .describe(
      'Filter queued proposals by source thought id. OPTIONAL for "list". REJECTED for all other actions.'
    ),
  created_after: z.iso
    .datetime()
    .optional()
    .describe(
      'Only proposals created at or after this ISO timestamp (UTC, e.g. 2026-01-01T00:00:00.000Z). OPTIONAL for "list". REJECTED for all other actions.'
    ),
  project_id: z
    .never({ error: 'project_id was removed; use cwd' })
    .optional()
    .describe('Removed; use cwd.'),
  cwd: z
    .string()
    .optional()
    .describe(
      'Working directory — auto-resolves project. OPTIONAL for "enqueue" and "list". ACCEPTED AND IGNORED for "apply", "apply_batch", "rollback", "reject".'
    ),
  limit: proposalsLimitSchema
    .optional()
    .describe(
      'Max rows (default 100, 1-1000) for "list"; max items for "apply_batch". OPTIONAL for "list" and "apply_batch". REJECTED for all other actions.'
    ),
  max_items: z
    .never({ error: 'max_items was removed; use max_proposals' })
    .optional()
    .describe('Removed; use max_proposals.')
}
