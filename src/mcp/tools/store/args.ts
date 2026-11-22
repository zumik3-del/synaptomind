import { z } from 'zod/v4'
import { getThoughtLimitsDB } from '../../../config.thought-limits'
import { EDGE_TYPES } from '../../../services/edges.service'
import { thoughtStatusSchema } from '../../../validation'
import { BULK_ITEMS_MAX } from '../../../services/bulk.service'
import { edgeIdsArg, isProfileRefusal, linksArg, thoughtsArg, urlLinkItem } from './items'

export function storeContentArg(): z.ZodOptional<z.ZodString> {
  return z
    .string()
    .optional()
    .describe(
      `REQUIRED for "create". OPTIONAL for "update". REJECTED for "link", "link_batch", "unlink", "unlink_batch", "retype". Recommended soft limit: ${getThoughtLimitsDB().softLimit} chars.`
    )
}

export const STORE_ARGS = {
  content: storeContentArg(),
  tags: z
    .array(z.string())
    .optional()
    .describe(
      'OPTIONAL for "create" and "update" (update merges with existing tags by default; use tags_mode=replace to overwrite the whole tag set). REJECTED for "link", "link_batch", "unlink", "unlink_batch", "retype".'
    ),
  tags_mode: z
    .enum(['replace', 'merge'])
    .optional()
    .describe(
      'update only: how to apply `tags` — "merge" (default) unions with existing tags, "replace" overwrites the whole tag set. REJECTED for all other actions.'
    ),
  status: thoughtStatusSchema
    .optional()
    .describe(
      'Thought status (draft/active/archived). OPTIONAL for "create" and "update"; "update" rejects "archived" (archive through memory_supersede action=archive). REJECTED for "link", "link_batch", "unlink", "unlink_batch", "retype".'
    ),
  project_id: z
    .never({ error: 'project_id was removed; a create takes the project its cwd resolves to' })
    .optional()
    .describe('Removed; a create takes the project its cwd resolves to.'),
  cwd: z
    .string()
    .optional()
    .describe(
      'Working directory — resolves the project a "create" lands in and the project scope meta.scope reports (always pass for "create"/"update"). ACCEPTED AND IGNORED for "link", "link_batch", "unlink", "unlink_batch", "retype".'
    ),
  parent_id: z
    .string()
    .optional()
    .describe('Parent thought ID. OPTIONAL for "create". REJECTED for all other actions.'),
  is_profile: isProfileRefusal.describe('Retired: remove this field; there is no replacement.'),
  is_protected: z
    .boolean()
    .optional()
    .describe(
      'Protect from auto-deletion. OPTIONAL for "create" and "update". REJECTED for "link", "link_batch", "unlink", "unlink_batch", "retype".'
    ),
  is_global: z
    .boolean()
    .optional()
    .describe(
      'Mark as global thought (appears in all project-scoped searches). OPTIONAL for "create" and "update". REJECTED for "link", "link_batch", "unlink", "unlink_batch", "retype".'
    ),
  surface_after: z.iso
    .datetime()
    .nullable()
    .optional()
    .describe(
      'update only: pending surfacing delay as an ISO timestamp (UTC, e.g. 2026-01-01T00:00:00.000Z); pass null to clear. REJECTED for all other actions.'
    ),
  url_links: z
    .array(urlLinkItem)
    .optional()
    .describe(
      'URL links. OPTIONAL for "create" and "update": create sets the initial list, update replaces the whole set in array order (an omitted field leaves the set untouched, [] clears it). The array order is the link order. For "bulk_create" each item carries its own url_links with these semantics, so this top-level field is rejected for it. REJECTED for all other actions.'
    ),
  thoughts: thoughtsArg
    .optional()
    .describe(
      `REQUIRED ONLY for "bulk_create". Thoughts to create in one run-level transaction with a savepoint per item, so a failing item does not roll back its neighbours (1-${BULK_ITEMS_MAX} items, the same bound this schema enforces). VALIDATED before the action runs, so a present thoughts must be a non-empty array of valid items whatever the action — an empty array is refused with "thoughts is required for bulk_create action". REJECTED for all other actions. Each item is a strict object taking the create item fields — content (required), tags, status, parent_id, is_protected, is_global, url_links — plus project_id, relation and source; url_links is written per item in array order in the same transaction, and is_global reaches the row. Failure splits two ways: a schema-level refusal (an unknown key, a wrong type, the retired is_profile) drops the whole call and writes nothing, while a per-item failure (e.g. a parent_id that does not exist) yields that item's error row at its index and the rest of the batch commits. The top-level content/tags/status/parent_id/is_protected/is_global/url_links are rejected for "bulk_create" (each item carries its own).`
    ),
  thought_id: z
    .string()
    .optional()
    .describe(
      'REQUIRED for "update". REJECTED for "link" (use source_id). REJECTED for "create", "link_batch", "unlink", "unlink_batch", "retype".'
    ),
  source_id: z
    .string()
    .optional()
    .describe(
      'REQUIRED ONLY for "link" (source endpoint, same spelling as memory_supersede merge). REJECTED for all other actions.'
    ),
  target_id: z
    .string()
    .optional()
    .describe(
      'REQUIRED ONLY for "link" (target side, same spelling as memory_supersede merge). REJECTED for all other actions.'
    ),
  links: linksArg
    .optional()
    .describe(
      'REQUIRED ONLY for "link_batch". Edges to create as {source, target, type?} pairs (1-1000); partial failures are reported per item. REJECTED for all other actions.'
    ),
  edge_type: z
    .enum(EDGE_TYPES)
    .optional()
    .describe(
      'Edge type (default: related). OPTIONAL for "link". REJECTED for "create", "update", "link_batch", "unlink", "unlink_batch", "retype".'
    ),
  edge_id: z
    .string()
    .optional()
    .describe(
      'REQUIRED for "unlink" and "retype". The edge to modify. REJECTED for all other actions.'
    ),
  edge_ids: edgeIdsArg
    .optional()
    .describe(
      'REQUIRED ONLY for "unlink_batch". Edge IDs to delete/preview in one call (1-1000); partial failures are reported per item. REJECTED for all other actions.'
    ),
  new_type: z
    .enum(EDGE_TYPES)
    .optional()
    .describe('REQUIRED for "retype". The new edge type. REJECTED for all other actions.'),
  confirm: z
    .boolean()
    .optional()
    .describe(
      'CONSUMED by "unlink", "unlink_batch", "retype" (true executes the write; false/omitted is a dry-run). REJECTED for all other actions.'
    ),
  preview_token: z
    .string()
    .optional()
    .describe(
      'OPTIONAL preview token returned by a prior preview. CONSUMED by "unlink" and "retype" (true executes with token validation; missing/stale fails). REJECTED for all other actions.'
    )
}
