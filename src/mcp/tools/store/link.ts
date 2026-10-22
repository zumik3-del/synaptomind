import { z } from 'zod/v4'
import { createEdgeService } from '../../../services/edges.service'
import type { ActionArgs, ActionHandler } from '../action-tool'

/**
 * `source_id` is the merge-compatible spelling of link's `thought_id` (task
 * #1966): `memory_supersede action=merge` names its endpoints `source_id` and
 * `target_id`, so one vocabulary covers both writes. The alias is accepted, not
 * a rename — `thought_id` stays the canonical field for the other actions.
 */
const SOURCE_REQUIRED = 'thought_id is required for link action (source); source_id is accepted as an alias'
const TARGET_REQUIRED = 'target_id is required for link action'

export const linkHandler: ActionHandler = {
  input: z
    .object({
      thought_id: z.string({ error: SOURCE_REQUIRED }).min(1, SOURCE_REQUIRED).optional(),
      source_id: z.string({ error: SOURCE_REQUIRED }).min(1, SOURCE_REQUIRED).optional(),
      target_id: z.string({ error: TARGET_REQUIRED }).optional()
    })
    // Both endpoints are optional in the shape so the source is checked first:
    // a call carrying neither reports the source endpoint, as it always has.
    .superRefine((args, ctx) => {
      if (!args.thought_id && !args.source_id) {
        ctx.addIssue({ code: 'custom', message: SOURCE_REQUIRED, path: ['thought_id'] })
      } else if (!args.target_id) {
        ctx.addIssue({ code: 'custom', message: TARGET_REQUIRED, path: ['target_id'] })
      }
    }),
  run(args: ActionArgs) {
    // An explicit source_id wins when both names are supplied; existing callers
    // only ever send thought_id, so their behaviour is unchanged.
    const sourceId = (args.source_id ?? args.thought_id) as string
    return createEdgeService(sourceId, args.target_id as string, args.edge_type as string | undefined)
  }
}
