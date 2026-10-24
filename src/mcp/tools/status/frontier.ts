import { z } from 'zod/v4'
import { getFrontierService } from '../../../services/frontier.service'
import { resolveProjectId } from '../utils'
import type { ActionArgs, ActionHandler } from '../action-tool'

export const frontierHandler: ActionHandler = {
  input: z.object({
    limit: z.number().int().min(1).max(50, 'frontier limit must be at most 50').optional()
  }),
  run(args: ActionArgs) {
    const projectFilter = resolveProjectId(args.cwd as string | undefined)
    return getFrontierService({ project_id: projectFilter, k: args.limit as number | undefined })
  }
}
