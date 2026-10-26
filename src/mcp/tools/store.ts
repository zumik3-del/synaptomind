import { z } from 'zod/v4'
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { getAdvertisedSoftLimitService } from '../../services/settings.service'
import { EDGE_TYPES } from '../../services/edges.service'
import { thoughtStatusSchema } from '../../validation'
import { registerActionTool } from './action-tool'
import { createHandler } from './store/create'
import { updateHandler } from './store/update'
import { linkHandler } from './store/link'
import { linkBatchHandler } from './store/link-batch'
import { unlinkHandler } from './store/unlink'
import { unlinkBatchHandler } from './store/unlink-batch'
import { retypeHandler } from './store/retype'
import { bulkCreateHandler } from './store/bulk'

const handlers = {
  create: createHandler,
  update: updateHandler,
  link: linkHandler,
  link_batch: linkBatchHandler,
  unlink: unlinkHandler,
  unlink_batch: unlinkBatchHandler,
  retype: retypeHandler,
  bulk_create: bulkCreateHandler
}

export function registerMemoryStore(server: McpServer) {
  registerActionTool(server, {
    name: 'memory_store',
    description: `Store and modify thoughts. Answers the shared envelope: { item, meta } for a single-object action, { items, meta } for a batch; meta.counts carries the aggregate (linked/failed, created/failed, deleted/failed). A non-mutating preview sets meta.preview={token,destructive:true}. Actions: create, update (tags merge by default; tags_mode=replace to overwrite), link, link_batch (one transaction, per-item results), unlink (preview→confirm; dry-run default), unlink_batch (one transaction, per-edge status, confirm-gated), retype (preview→confirm; returns old/new edge id), bulk_create (create up to 10000 thoughts in one transaction; same shape as HTTP /api/thoughts/bulk).`,
    inputSchema: {
      action: z.enum(['create', 'update', 'link', 'link_batch', 'unlink', 'unlink_batch', 'retype', 'bulk_create']).describe('The specific action to perform. This dictates which other parameters are required.'),
      content: z.string().optional().describe(`REQUIRED for "create". OPTIONAL for "update". IGNORED for "link", "link_batch", "unlink", "unlink_batch", "retype". Recommended soft limit: ${getAdvertisedSoftLimitService()} chars.`),
      tags: z.array(z.string()).optional().describe('OPTIONAL for "create" and "update" (update merges with existing tags by default; use tags_mode=replace to overwrite the whole tag set). IGNORED for "link", "link_batch", "unlink", "unlink_batch", "retype".'),
      tags_mode: z.enum(['replace', 'merge']).optional().describe('update only: how to apply `tags` — "merge" (default) unions with existing tags, "replace" overwrites the whole tag set. IGNORED for all other actions.'),
      status: thoughtStatusSchema.optional().describe('Thought status (draft/active/archived). OPTIONAL for "create" and "update"; "update" rejects "archived" (archive through memory_supersede action=archive). IGNORED for "link", "link_batch", "unlink", "unlink_batch", "retype".'),
      project_id: z.never({ error: 'project_id was removed; use cwd' }).optional().describe('Removed; use cwd.'),
      cwd: z.string().optional().describe('Working directory — auto-resolves project for "create"/"update" (always pass for those). IGNORED for "link", "link_batch", "unlink", "unlink_batch", "retype".'),
      parent_id: z.string().optional().describe('Parent thought ID. OPTIONAL for "create". IGNORED for all other actions.'),
      is_profile: z.never({ error: 'is_profile is retired; remove this field (there is no replacement)' }).optional().describe('Retired: remove this field; there is no replacement.'),
      is_protected: z.boolean().optional().describe('Protect from auto-deletion. OPTIONAL for "create" and "update". IGNORED for "link", "link_batch", "unlink", "unlink_batch", "retype".'),
      is_global: z.boolean().optional().describe('Mark as global thought (appears in all project-scoped searches). OPTIONAL for "create" and "update". IGNORED for "link", "link_batch", "unlink", "unlink_batch", "retype".'),
      surface_after: z.iso.datetime().nullable().optional().describe('update only: pending surfacing delay as an ISO timestamp (UTC, e.g. 2026-01-01T00:00:00.000Z); pass null to clear. IGNORED for all other actions.'),
      url_links: z.array(z.object({ text: z.string(), url: z.string() })).optional().describe('URL links. OPTIONAL for "create". IGNORED for all other actions.'),
      thoughts: z.array(z.unknown()).optional().describe('REQUIRED ONLY for "bulk_create". Thoughts to create in one transaction (1-10000 items), same shape as the HTTP /api/thoughts/bulk body items. IGNORED for all other actions.'),
      thought_id: z.string().optional().describe('REQUIRED for "update". REJECTED for "link" (use source_id). IGNORED for "create", "link_batch", "unlink", "unlink_batch", "retype".'),

      source_id: z.string().optional().describe('REQUIRED ONLY for "link" (source endpoint, same spelling as memory_supersede merge). IGNORED for all other actions.'),
      target_id: z.string().optional().describe('REQUIRED ONLY for "link" (target side, same spelling as memory_supersede merge). IGNORED for all other actions.'),
      links: z
        .array(z.object({ source: z.string(), target: z.string(), type: z.enum(EDGE_TYPES).optional() }))
        .optional()
        .describe('REQUIRED ONLY for "link_batch". Edges to create as {source, target, type?} pairs (1-1000); partial failures are reported per item. IGNORED for all other actions.'),
      edge_type: z.enum(EDGE_TYPES).optional().describe('Edge type (default: related). OPTIONAL for "link". IGNORED for "create", "update", "link_batch", "unlink", "unlink_batch", "retype".'),
      edge_id: z.string().optional().describe('REQUIRED for "unlink" and "retype". The edge to modify. IGNORED for all other actions.'),
      edge_ids: z.array(z.string()).optional().describe('REQUIRED ONLY for "unlink_batch". Edge IDs to delete/preview in one call (1-1000); partial failures are reported per item. IGNORED for all other actions.'),
      new_type: z.enum(EDGE_TYPES).optional().describe('REQUIRED for "retype". The new edge type. IGNORED for all other actions.'),
      confirm: z.boolean().optional().describe('CONSUMED by "unlink", "unlink_batch", "retype" (true executes the write; false/omitted is a dry-run). IGNORED for all other actions.'),
      preview_token: z.string().optional().describe('OPTIONAL preview token returned by a prior preview. CONSUMED by "unlink" and "retype" (true executes with token validation; missing/stale fails). IGNORED for all other actions.')
    },
    handlers
  })
}
