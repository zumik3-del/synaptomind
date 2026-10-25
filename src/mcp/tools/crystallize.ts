import { z } from 'zod/v4'
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { graphLimitSchema, graphOffsetSchema, graphStatusSchema } from '../../validation'
import { registerActionTool } from './action-tool'
import { graphHandler } from './crystallize/graph'
import { clusterHandler } from './crystallize/cluster'
import { autoClusterHandler } from './crystallize/auto-cluster'

const handlers = {
  graph: graphHandler,
  cluster: clusterHandler,
  auto_cluster: autoClusterHandler
}

export function registerMemoryCrystallize(server: McpServer) {
  registerActionTool(server, {
    name: 'memory_crystallize',
    description: `Visualize and reorganize clusters. Answers the shared envelope { item, meta } / { items, meta } (aggregate in meta.counts; a preview sets meta.preview={token,destructive:true}). One documented exception: action=graph answers { items: nodes, edges, meta } — the graph is two collections, so edges sit beside items as a named field. Actions: graph, cluster, auto_cluster (Union-Find; preview→confirm — clusters are created only with confirm: true).`,
    inputSchema: {
      action: z.enum(['graph', 'cluster', 'auto_cluster']).describe('Action'),
      thought_ids: z.array(z.string()).optional().describe('Thought IDs. REQUIRED for "cluster". IGNORED for "graph" and "auto_cluster".'),
      project_id: z.never({ error: 'project_id was removed; use cwd' }).optional().describe('Removed; use cwd.'),
      cwd: z.string().optional().describe('Working directory — auto-resolves project. OPTIONAL for "graph" and "cluster" (always pass for those; auto_cluster operates globally). IGNORED for "auto_cluster".'),
      status: graphStatusSchema.optional().describe('Filter by status (default: active). OPTIONAL for "graph". IGNORED for "cluster" and "auto_cluster".'),
      limit: graphLimitSchema.optional().describe('Max nodes to return (default 500, 1-2000). OPTIONAL for "graph". IGNORED for "cluster" and "auto_cluster".'),
      offset: graphOffsetSchema.optional().describe('Offset for pagination (default 0, 0-1000000). OPTIONAL for "graph". IGNORED for "cluster" and "auto_cluster".'),
      title: z.string().optional().describe('Cluster title. OPTIONAL for "cluster". IGNORED for "graph" and "auto_cluster".'),
      tags: z.array(z.string()).optional().describe('Tags. OPTIONAL for "cluster". IGNORED for "graph" and "auto_cluster".'),
      min_age_days: z.coerce.number().int().min(0).max(3650).optional().describe('Min age in days (default from config). OPTIONAL for "auto_cluster". IGNORED for "graph" and "cluster".'),
      min_similarity: z.coerce.number().min(0).max(1).optional().describe('Min similarity threshold 0-1 (default from config). OPTIONAL for "auto_cluster". IGNORED for "graph" and "cluster".'),
      min_members: z.coerce.number().int().min(1).max(1000).optional().describe('Min members per cluster (default from config). OPTIONAL for "auto_cluster". IGNORED for "graph" and "cluster".'),
      confirm: z.boolean().optional().describe('CONSUMED by "auto_cluster" (true creates clusters; false/omitted previews). IGNORED for "graph" and "cluster".'),
      preview_token: z.string().optional().describe('OPTIONAL preview token returned by a prior preview. CONSUMED by "auto_cluster" (true executes with token validation; missing/stale fails). IGNORED for "graph" and "cluster".'),
      compact: z.boolean().optional().describe('Compact output: trim to minimal fields (id, content, status, tags as strings, project). OPTIONAL for "graph". IGNORED for "cluster" and "auto_cluster".'),
      fields: z.array(z.string()).optional().describe('Fields to include in output; intersected with available columns. OPTIONAL for "graph". IGNORED for "cluster" and "auto_cluster".'),
      // Tombstone for the retired preview flag: only confirm is advertised.
      dry_run: z.never({ error: 'dry_run was removed; use confirm' }).optional().describe('Removed; use confirm.'),
    },
    handlers
  })
}
