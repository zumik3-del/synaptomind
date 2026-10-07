import { z } from 'zod/v4'
import { dissolveClusterService, getClusterThoughtService, listClusterMembersService } from '../../../services/cluster.service'
import { requiredString, type ActionArgs, type ActionHandler } from '../action-tool'

export const clusterDissolveHandler: ActionHandler = {
  input: z.object({
    cluster_id: requiredString('cluster_id is required for cluster_dissolve action')
  }),
  run(args: ActionArgs) {
    const clusterId = args.cluster_id as string
    const confirm = args.confirm === true

    if (!confirm) {
      const cluster = getClusterThoughtService(clusterId)
      if (!cluster) throw new Error(`Cluster not found: ${clusterId}`)
      const members = listClusterMembersService(clusterId)
      return {
        status: 'preview',
        cluster_id: clusterId,
        member_count: members.length,
        member_ids: members.map(m => m.id),
        consequence: `Deletes the cluster thought and ${members.length} member edges. Member thoughts become standalone.`
      }
    }

    const result = dissolveClusterService({ clusterId })
    return { status: 'dissolved', cluster_id: result.clusterId, deleted_edge_count: result.deletedEdgeCount, deleted_member_count: 0 }
  }
}
