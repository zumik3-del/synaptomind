import { crystallize } from '../../../services/crystals.service'
import { resolveProjectId } from '../utils'
import { type ActionArgs, type ActionHandler } from '../action-tool'

export const crystallizeHandler: ActionHandler = {
  run(args: ActionArgs) {
    const projectId = resolveProjectId(args.project_id as string | undefined, args.cwd as string | undefined)
    return crystallize({ thought_ids: args.thought_ids as string[] | undefined, cluster_id: args.cluster_id as string | undefined, style: args.style as 'runbook' | 'decision-log' | 'overview' | undefined, project_id: projectId })
  }
}
