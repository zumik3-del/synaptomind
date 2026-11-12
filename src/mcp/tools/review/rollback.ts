import { z } from 'zod/v4'
import { rollbackService as rollbackRun } from '../../../services/placement-rollback.service'
import { listAcceptedProposalsByRunService } from '../../../services/placement-proposals.service'
import { fingerprintOf, runGuarded } from '../../../services/confirm-gate.service'
import { collectionEnvelope } from '../envelope'
import { requiredString, type ActionArgs, type ActionHandler } from '../action-tool'
import { AGENT } from './apply'

/**
 * `edge_review action=rollback`: the per-row report is the answer (task #2181).
 *
 * Every row of the run becomes one `items` entry and the report's summary
 * becomes `meta.counts` (`reverted`/`skipped`/`refused`). `run_id` is not echoed:
 * the caller supplies it, so it is already known.
 */
export const rollbackHandler: ActionHandler = {
  input: z.object({
    run_id: requiredString('run_id is required for rollback action'),
    preview_token: z.string().optional()
  }),
  async run(args: ActionArgs) {
    const runId = args.run_id as string
    const rows = listAcceptedProposalsByRunService(runId)
    const fingerprint = fingerprintOf(
      runId,
      rows.length,
      rows.map(row => [row.id, row.state])
    )
    const outcome = await runGuarded(args, {
      kind: 'rollback',
      targetId: runId,
      fingerprint: () => fingerprint,
      preview: () => rollbackRun(runId, { confirm: false, decidedBy: AGENT }),
      apply: () => rollbackRun(runId, { confirm: true, decidedBy: AGENT })
    })

    const report = outcome.value
    return collectionEnvelope('rollback', report.items, {
      total: report.items.length,
      counts: report.summary,
      ...(outcome.status === 'preview' ? { preview: { token: outcome.token } } : {})
    })
  }
}
