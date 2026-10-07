import { detectEdgeProposals } from '../../../services/edge-detect.service'
import { resolveProjectId } from '../utils'
import { type ActionArgs, type ActionHandler } from '../action-tool'

export const edgeSuggestionsHandler: ActionHandler = {
  async run(args: ActionArgs) {
    const projectFilter = resolveProjectId(args.project_id as string | undefined, args.cwd as string | undefined)
    return detectEdgeProposals({ projectId: projectFilter })
  }
}
