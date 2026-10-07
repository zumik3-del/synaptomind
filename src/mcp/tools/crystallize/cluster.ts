import { z } from 'zod/v4'
import { createClusterService } from '../../../services/cluster.service'
import { resolveProjectId } from '../utils'
import { type ActionArgs, type ActionHandler } from '../action-tool'

export const clusterHandler: ActionHandler = {
  input: z.object({
    thought_ids: z
      .array(z.string(), { error: 'thought_ids is required for cluster action' })
      .min(1, 'thought_ids is required for cluster action')
  }),
  run(args: ActionArgs) {
    const projectId = resolveProjectId(args.project_id as string | undefined, args.cwd as string | undefined)
    return createClusterService({ thoughtIds: args.thought_ids as string[], title: args.title as string | undefined, tags: args.tags as string[] | undefined, projectId })
  }
}
