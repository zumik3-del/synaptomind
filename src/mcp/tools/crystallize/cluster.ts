import { z } from 'zod/v4'
import { createClusterService } from '../../../services/cluster.service'
import { itemEnvelope, writeEnvelopeScope } from '../envelope'
import { resolveProjectId, shapeThought } from '../utils'
import type { ActionArgs, ActionHandler } from '../action-tool'

export const clusterHandler: ActionHandler = {
  input: z.object({
    thought_ids: z
      .array(z.string(), { error: 'thought_ids is required for cluster action' })
      .min(1, 'thought_ids is required for cluster action')
  }),
  run(args: ActionArgs) {
    const projectId = resolveProjectId(args.cwd as string | undefined)
    const created = createClusterService({ thoughtIds: args.thought_ids as string[], title: args.title as string | undefined, tags: args.tags as string[] | undefined, projectId })
    // The new cluster, its member edges and its members are one object: `item`
    // carries them together with the read-surface hygiene applied (task #2181).
    return itemEnvelope(
      'cluster',
      {
        cluster: shapeThought(created.cluster),
        edges: created.edges,
        members: created.members.map(member => shapeThought(member))
      },
      { ...writeEnvelopeScope(args.cwd), counts: { members: created.members.length, edges: created.edges.length } }
    )
  }
}
