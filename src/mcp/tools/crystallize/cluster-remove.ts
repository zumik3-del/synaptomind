import { z } from 'zod/v4'
import { removeClusterMemberService, getClusterThoughtService, findClusterMemberEdgeService } from '../../../services/cluster.service'
import { requiredString, type ActionArgs, type ActionHandler } from '../action-tool'

export const clusterRemoveHandler: ActionHandler = {
  input: z.object({
    cluster_id: requiredString('cluster_id is required for cluster_remove action'),
    thought_id: requiredString('thought_id is required for cluster_remove action')
  }),
  run(args: ActionArgs) {
    const clusterId = args.cluster_id as string
    const thoughtId = args.thought_id as string
    const confirm = args.confirm === true

    if (!confirm) {
      const cluster = getClusterThoughtService(clusterId)
      if (!cluster) throw new Error(`Cluster not found: ${clusterId}`)
      const edgeId = findClusterMemberEdgeService(clusterId, thoughtId)
      if (!edgeId) throw new Error(`Thought ${thoughtId} is not a member of cluster ${clusterId}`)
      return {
        status: 'preview',
        cluster_id: clusterId,
        thought_id: thoughtId,
        edge_id: edgeId,
        consequence: `Removes '${thoughtId}' from cluster '${clusterId}'. The thought becomes standalone.`
      }
    }

    const result = removeClusterMemberService({ clusterId, thoughtId })
    return { status: 'removed', cluster_id: result.clusterId, thought_id: result.thoughtId, edge_id: result.edgeId }
  }
}
