import { z } from 'zod/v4'
import { createClusterService } from '../../../services/cluster.service'
import { itemEnvelope, writeEnvelopeScope } from '../envelope'
import { resolveProjectId, shapeEntity } from '../utils'
import { actionInput, type ActionArgs, type ActionHandler } from '../action-tool'
import { CRYSTALLIZE_ARGS } from './args'

export const clusterHandler: ActionHandler = {
  input: actionInput(CRYSTALLIZE_ARGS, ['thought_ids', 'title', 'tags'], {
    thought_ids: z
      .array(z.string(), { error: 'thought_ids is required for cluster action' })
      .min(1, 'thought_ids is required for cluster action')
  }),
  run(args: ActionArgs) {
    const projectId = resolveProjectId(args.cwd as string | undefined)
    const created = createClusterService({
      thoughtIds: args.thought_ids as string[],
      title: args.title as string | undefined,
      tags: args.tags as string[] | undefined,
      projectId
    })
    return itemEnvelope(
      'cluster',
      {
        cluster: shapeEntity(created.cluster),
        edges: created.edges,
        members: created.members.map(member => shapeEntity(member))
      },
      {
        ...writeEnvelopeScope(args.cwd),
        counts: { members: created.members.length, edges: created.edges.length }
      }
    )
  }
}
