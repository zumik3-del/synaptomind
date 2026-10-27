import { z } from 'zod/v4'
import { getFrontierService } from '../../../services/frontier.service'
import { collectionEnvelope, requireEnvelopeScope } from '../envelope'
import type { ActionArgs, ActionHandler } from '../action-tool'

/** `memory_status` action=frontier: `{ items, meta }`; `cwd` is required. */
export const frontierHandler: ActionHandler = {
  input: z.object({
    limit: z.number().int().min(1).max(50, 'frontier limit must be at most 50').optional()
  }),
  run(args: ActionArgs) {
    const { scope, warnings, projectId } = requireEnvelopeScope(args.cwd, 'memory_status', 'frontier')
    const { items } = getFrontierService({ project_id: projectId, k: args.limit as number | undefined })
    return collectionEnvelope('frontier', items, { scope, warnings })
  }
}
