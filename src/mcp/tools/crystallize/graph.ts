import { getGraphDataService } from '../../../services/graph.service'
import { projectFields, resolveProjectId } from '../utils'
import type { ActionArgs, ActionHandler } from '../action-tool'

export const graphHandler: ActionHandler = {
  run(args: ActionArgs) {
    const projectId = resolveProjectId(args.cwd as string | undefined)
    const data = getGraphDataService(projectId, args.status as string | undefined, args.limit as number | undefined, args.offset as number | undefined)
    const fields = args.fields
    if (Array.isArray(fields) && fields.length > 0) {
      data.nodes = data.nodes.map((n) => projectFields(n, { fields })) as unknown as typeof data.nodes
      data.edges = data.edges.map((e) => projectFields(e, { fields })) as unknown as typeof data.edges
    }
    return data
  }
}
