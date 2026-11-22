import { z } from 'zod/v4'
import { graphLimitSchema, graphOffsetSchema, graphStatusSchema } from '../../../validation'

export const CRYSTALLIZE_ARGS = {
  thought_ids: z
    .array(z.string(), { error: 'thought_ids is required for cluster action' })
    .min(1, 'thought_ids is required for cluster action')
    .optional()
    .describe('Thought IDs. REQUIRED for "cluster". REJECTED for "graph" and "auto_cluster".'),
  project_id: z
    .never({ error: 'project_id was removed; use cwd' })
    .optional()
    .describe('Removed; use cwd.'),
  cwd: z
    .string()
    .optional()
    .describe(
      'Working directory — auto-resolves project. OPTIONAL for "graph" and "cluster" (always pass for those; auto_cluster operates globally). ACCEPTED AND IGNORED for "auto_cluster".'
    ),
  status: graphStatusSchema
    .optional()
    .describe(
      'Filter by status (default: active). OPTIONAL for "graph". REJECTED for "cluster" and "auto_cluster".'
    ),
  limit: graphLimitSchema
    .optional()
    .describe(
      'Max nodes to return (default 500, 1-2000). OPTIONAL for "graph". REJECTED for "cluster" and "auto_cluster".'
    ),
  offset: graphOffsetSchema
    .optional()
    .describe(
      'Offset for pagination (default 0, 0-1000000). OPTIONAL for "graph". REJECTED for "cluster" and "auto_cluster".'
    ),
  title: z
    .string()
    .optional()
    .describe('Cluster title. OPTIONAL for "cluster". REJECTED for "graph" and "auto_cluster".'),
  tags: z
    .array(z.string())
    .optional()
    .describe('Tags. OPTIONAL for "cluster". REJECTED for "graph" and "auto_cluster".'),
  min_age_days: z.coerce
    .number()
    .int()
    .min(0)
    .max(3650)
    .optional()
    .describe(
      'Min age in days (default from config). OPTIONAL for "auto_cluster". REJECTED for "graph" and "cluster".'
    ),
  min_similarity: z.coerce
    .number()
    .min(0)
    .max(1)
    .optional()
    .describe(
      'Maximum cosine distance between neighbours (0-1; lower is tighter, default from config). OPTIONAL for "auto_cluster". REJECTED for "graph" and "cluster".'
    ),
  min_members: z.coerce
    .number()
    .int()
    .min(1)
    .max(1000)
    .optional()
    .describe(
      'Min members per cluster (default from config). OPTIONAL for "auto_cluster". REJECTED for "graph" and "cluster".'
    ),
  confirm: z
    .boolean()
    .optional()
    .describe(
      'CONSUMED by "auto_cluster" (true creates clusters; false/omitted previews). REJECTED for "graph" and "cluster".'
    ),
  preview_token: z
    .string()
    .optional()
    .describe(
      'OPTIONAL preview token returned by a prior preview. CONSUMED by "auto_cluster" (true executes with token validation; missing/stale fails). REJECTED for "graph" and "cluster".'
    ),
  fields: z
    .array(z.string())
    .optional()
    .describe(
      'Fields to include in each node and edge; intersected with the columns the graph offers. OPTIONAL for "graph". REJECTED for "cluster" and "auto_cluster".'
    ),
  dry_run: z
    .never({ error: 'dry_run was removed; use confirm' })
    .optional()
    .describe('Removed; use confirm.')
}
