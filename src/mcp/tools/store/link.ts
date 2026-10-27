import { z } from 'zod/v4'
import { createEdgeService } from '../../../services/edges.service'
import { itemEnvelope } from '../envelope'
import type { ActionArgs, ActionHandler } from '../action-tool'

const SOURCE_REQUIRED = 'source_id is required for link action'
const TARGET_REQUIRED = 'target_id is required for link action'
const THOUGHT_ID_RETIRED = 'thought_id is retired for link action; use source_id instead'

export const linkHandler: ActionHandler = {
  input: z
    .object({
      thought_id: z.never({ error: THOUGHT_ID_RETIRED }).optional().describe('Retired; use source_id instead.'),
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
    const edge = createEdgeService(args.source_id as string, args.target_id as string, args.edge_type as string | undefined)
    // Every id on the wire is a string, so a caller never has to cast.
    return itemEnvelope('link', {
      id: String(edge.id),
      source_id: String(edge.source_id),
      target_id: String(edge.target_id),
      type: edge.type,
      created_at: edge.created_at
    })
  }
}
