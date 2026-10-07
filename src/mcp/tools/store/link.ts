import { z } from 'zod/v4'
import { createEdgeService } from '../../../services/edges.service'
import { requiredString, type ActionArgs, type ActionHandler } from '../action-tool'

export const linkHandler: ActionHandler = {
  input: z.object({
    thought_id: requiredString('thought_id is required for link action (source)'),
    target_id: requiredString('target_id is required for link action')
  }),
  run(args: ActionArgs) {
    return createEdgeService(args.thought_id as string, args.target_id as string, args.edge_type as string | undefined)
  }
}
