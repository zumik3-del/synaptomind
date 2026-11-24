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
    description: `Visualize and reorganize clusters. Answers the shared envelope { item, meta } / { items, meta } (aggregate in meta.counts; a preview sets meta.preview={token,destructive:true}). One documented exception: action=graph answers { items: nodes, edges, meta } — the graph is two collections, so edges sit beside items as a named field. Actions: graph, cluster, auto_cluster (Union-Find; preview→confirm — clusters are created only with confirm: true). Every action refuses an argument that belongs to another one.`,
    inputSchema: {
      action: z.enum(['graph', 'cluster', 'auto_cluster']).describe('Action'),
      ...CRYSTALLIZE_ARGS
    },
    handlers
  })
}
