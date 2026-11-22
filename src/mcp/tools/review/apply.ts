import { applyProposalService } from '../../../services/placement-apply.service'
import { getProposalService } from '../../../services/placement-proposals.service'
import { fingerprintOf, runGuarded } from '../../../services/confirm-gate.service'
import { itemEnvelope } from '../envelope'
import { actionInput, requiredString, type ActionArgs, type ActionHandler } from '../action-tool'
import { REVIEW_ARGS } from './args'

export const AGENT = 'edge_review'

export const applyHandler: ActionHandler = {
  input: actionInput(REVIEW_ARGS, ['proposal_id', 'run_id', 'confirm', 'preview_token'], {
    proposal_id: requiredString('proposal_id is required for apply action')
  }),
  async run(args: ActionArgs) {
    const proposalId = args.proposal_id as string
    const row = getProposalService(proposalId)
    const outcome = await runGuarded(args, {
      kind: 'apply',
      targetId: proposalId,
      fingerprint: () =>
        row
          ? fingerprintOf(
              row.id,
              row.state,
              row.fingerprint,
              row.created_at,
              row.expires_at,
              row.result,
              row.run_id
            )
          : null,
      preview: () =>
        applyProposalService(proposalId, {
          confirm: false,
          runId: args.run_id as string | undefined,
          decidedBy: AGENT
        }),
      apply: () =>
        applyProposalService(proposalId, {
          confirm: true,
          runId: args.run_id as string | undefined,
          decidedBy: AGENT
        })
    })

    return outcome.status === 'preview'
      ? itemEnvelope('apply', outcome.value, { preview: { token: outcome.token } })
      : itemEnvelope('apply', outcome.value)
  }
}
