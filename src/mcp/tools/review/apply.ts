import { z } from 'zod/v4'
import { applyProposalService } from '../../../services/placement-apply.service'
import { requiredString, type ActionArgs, type ActionHandler } from '../action-tool'

/** Audit label recorded on apply/reject/rollback decisions (ADR §2.8). */
export const AGENT = 'memory_review'

export const applyHandler: ActionHandler = {
  input: z.object({ proposal_id: requiredString('proposal_id is required for apply action') }),
  run(args: ActionArgs) {
    return applyProposalService(args.proposal_id as string, {
      confirm: args.confirm === true,
      runId: args.run_id as string | undefined,
      decidedBy: AGENT
    })
  }
}
