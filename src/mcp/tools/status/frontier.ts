import { getFrontier } from '../../../services/frontier.service'
import { resolveProjectId } from '../utils'
import { type ActionArgs, type ActionHandler } from '../action-tool'

export const frontierHandler: ActionHandler = {
  run(args: ActionArgs) {
    const projectFilter = resolveProjectId(args.project_id as string | undefined, args.cwd as string | undefined)
    return getFrontier({ project_id: projectFilter, k: args.k as number | undefined })
  }
}
