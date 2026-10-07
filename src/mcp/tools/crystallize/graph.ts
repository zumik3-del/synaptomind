import { getGraphDataService } from '../../../services/graph.service'
import { resolveProjectId } from '../utils'
import { type ActionArgs, type ActionHandler } from '../action-tool'

export const graphHandler: ActionHandler = {
  run(args: ActionArgs) {
    const projectId = resolveProjectId(args.project_id as string | undefined, args.cwd as string | undefined)
    return getGraphDataService(projectId, args.status as string | undefined, args.limit as number | undefined)
  }
}
