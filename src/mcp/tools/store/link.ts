import { z } from 'zod/v4'
import { createEdgeService } from '../../../services/edges.service'
import type { ActionArgs, ActionHandler } from '../action-tool'

const SOURCE_REQUIRED = 'source_id is required for link action'
const TARGET_REQUIRED = 'target_id is required for link action'

export const linkHandler: ActionHandler = {
  input: z
    .object({
      source_id: z.string({ error: SOURCE_REQUIRED }).min(1, SOURCE_REQUIRED).optional(),
      target_id: z.string({ error: TARGET_REQUIRED }).optional()
    })
    .superRefine((args, ctx) => {
      if (!args.source_id) {
        ctx.addIssue({ code: 'custom', message: SOURCE_REQUIRED, path: ['source_id'] })
      } else if (!args.target_id) {
        ctx.addIssue({ code: 'custom', message: TARGET_REQUIRED, path: ['target_id'] })
      }
    }),
  run(args: ActionArgs) {
    return createEdgeService(args.source_id as string, args.target_id as string, args.edge_type as string | undefined)
  }
}
