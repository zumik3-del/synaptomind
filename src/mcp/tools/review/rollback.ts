import { rollbackService as rollbackRun } from '../../../services/placement-rollback.service'
import { listAcceptedProposalsByRunService } from '../../../services/placement-proposals.service'
import { fingerprintOf, runGuarded } from '../../../services/confirm-gate.service'
import { collectionEnvelope } from '../envelope'
import { actionInput, requiredString, type ActionArgs, type ActionHandler } from '../action-tool'
import { REVIEW_ARGS } from './args'
import { AGENT } from './apply'

export const rollbackHandler: ActionHandler = {
  input: actionInput(REVIEW_ARGS, ['run_id', 'confirm', 'preview_token'], {
    run_id: requiredString('run_id is required for rollback action')
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
