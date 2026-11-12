import { z } from 'zod/v4'
import { applyProposalService } from '../../../services/placement-apply.service'
import { getProposalService } from '../../../services/placement-proposals.service'
import { fingerprintOf, runGuarded } from '../../../services/confirm-gate.service'
import { itemEnvelope } from '../envelope'
import { requiredString, type ActionArgs, type ActionHandler } from '../action-tool'

/** Audit label recorded on apply/reject/rollback decisions (ADR §2.8). */
export const AGENT = 'edge_review'

export const applyHandler: ActionHandler = {
  input: z.object({
    proposal_id: requiredString('proposal_id is required for apply action'),
    preview_token: z.string().optional()
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
      preview: token => {
        const result = applyProposalService(proposalId, {
          confirm: false,
          runId: args.run_id as string | undefined,
          decidedBy: AGENT
        })
        return {
          ...(result as unknown as Record<string, unknown>),
          ...(token === null ? {} : { preview_token: token })
        }
      },
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
