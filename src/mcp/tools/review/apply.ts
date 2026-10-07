import { z } from 'zod/v4'
import { applyProposal } from '../../../services/placement-apply.service'
import { checkDryRunFirst, checkItemGuards, noteDryRun } from '../../../services/apply-run-guards'
import { requiredString, type ActionArgs, type ActionHandler } from '../action-tool'

/** Audit label recorded on apply/reject/rollback decisions (ADR §2.8). */
export const AGENT = 'memory_review'

export const applyHandler: ActionHandler = {
  input: z.object({ proposal_id: requiredString('proposal_id is required for apply action') }),
  run(args: ActionArgs) {
    const proposalId = args.proposal_id as string
    const confirm = args.confirm === true
    const runId = args.run_id as string | undefined
    // A confirm of a triage run must follow a dry-run preview of the same run
    // (config.triage.requireDryRunFirst, ADR 2026-09-29 §2.7 §2.8), and must
    // fit the run's per-item caps — one item at a time is still one run.
    const refusal = confirm
      ? checkDryRunFirst([proposalId], runId) ?? checkItemGuards(proposalId, { confirm, runId })
      : undefined
    if (refusal) return { proposal_id: proposalId, status: 'refused', refusal }
    const result = applyProposal(proposalId, { confirm, runId, decidedBy: AGENT })
    if (!confirm) noteDryRun([proposalId], runId)
    return result
  }
}
