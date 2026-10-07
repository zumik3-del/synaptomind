import { z } from 'zod/v4'
import { proposePlacementPlan } from '../../../services/placement/engine'
import { resolveProjectId } from '../utils'
import { type ActionArgs, type ActionHandler } from '../action-tool'

export const proposeHandler: ActionHandler = {
  input: z
    .object({
      thought_id: z.string().optional(),
      content: z.string().optional()
    })
    .refine(v => v.thought_id !== undefined || v.content !== undefined, {
      message: 'provide thought_id (existing thought) or content (draft)',
      path: ['thought_id']
    }),
  async run(args: ActionArgs) {
    const projectFilter = resolveProjectId(args.project_id as string | undefined, args.cwd as string | undefined)
    return proposePlacementPlan(
      {
        thoughtId: args.thought_id as string | undefined,
        content: args.content as string | undefined,
        projectId: projectFilter
      },
      { projectId: projectFilter }
    )
  }
}
