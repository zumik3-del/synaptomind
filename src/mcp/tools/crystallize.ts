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
    description: `Read and maintain the cluster graph — cluster thoughts plus the cluster edges that point at their members. Additive only: nothing is deleted or overwritten, so a bad call costs stray rows, not data. Answers the shared envelope { item, meta } / { items, meta } (aggregate in meta.counts; a preview sets meta.preview={token,destructive:true}), with one documented exception: action=graph answers { items: nodes, edges, meta } because a graph is two collections. Actions: graph, cluster, auto_cluster (Union-Find; preview→confirm — clusters are created only with confirm: true). Reading existing clusters is memory_recall action=clusters; this is the tool that creates them. Every action refuses an argument that belongs to another one.`,
    inputSchema: {
      action: z.enum(['graph', 'cluster', 'auto_cluster']).describe('Action'),
      ...CRYSTALLIZE_ARGS
    },
    handlers
  })
}
