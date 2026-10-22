import { getFrontierService } from '../../../services/frontier.service'
import { resolveProjectId } from '../utils'
import type { ActionArgs, ActionHandler } from '../action-tool'

export const frontierHandler: ActionHandler = {
  run(args: ActionArgs) {
    const projectFilter = resolveProjectId(args.project_id as string | undefined, args.cwd as string | undefined)
    return getFrontierService({ project_id: projectFilter, k: args.limit as number | undefined })
  }
}
