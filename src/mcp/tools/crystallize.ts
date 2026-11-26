import { z } from 'zod/v4'
import type { McpServer } from '@modelcontextprotocol/server'
import { ADDS_ONLY, registerActionTool } from './action-tool'
import { graphHandler } from './crystallize/graph'
import { clusterHandler } from './crystallize/cluster'
import { autoClusterHandler } from './crystallize/auto-cluster'
import { CRYSTALLIZE_ARGS } from './crystallize/args'

const handlers = {
  graph: graphHandler,
  cluster: clusterHandler,
  auto_cluster: autoClusterHandler
}

export function registerMemoryCrystallize(server: McpServer) {
  registerActionTool(server, {
    name: 'memory_crystallize',
    annotations: ADDS_ONLY,
    description: `Read and maintain the cluster graph: cluster thoughts plus the cluster edges pointing at their members. Additive only: nothing is deleted or overwritten. Answers { item, meta } / { items, meta }, with one documented exception: action=graph answers { items: nodes, edges, meta }, because a graph is two collections. Actions: graph, cluster, auto_cluster (Union-Find; preview→confirm, clusters created only with confirm: true). memory_recall action=search with is_cluster=true reads them; this tool creates them.`,
    inputSchema: {
      action: z.enum(['graph', 'cluster', 'auto_cluster']).describe('Action'),
      ...CRYSTALLIZE_ARGS
    },
    handlers
  })
}
