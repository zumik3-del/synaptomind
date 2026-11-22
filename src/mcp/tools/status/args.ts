import { z } from 'zod/v4'
import { severitySchema } from '../../../services/health-check.types'

export const STATUS_ARGS = {
  names: z
    .array(z.string())
    .optional()
    .describe('Filter by slot names. OPTIONAL for "slots". REJECTED for all other actions.'),
  limit: z.coerce
    .number()
    .int()
    .min(1)
    .max(50)
    .optional()
    .describe(
      'Max frontier results (1-50, default 10). OPTIONAL for "frontier". REJECTED for all other actions.'
    ),
  slots_limit: z.coerce
    .number()
    .int()
    .min(1)
    .max(1000)
    .optional()
    .describe(
      'Max pending_items for slots paging (1-1000). OPTIONAL for "slots". REJECTED for all other actions.'
    ),
  offset: z.coerce
    .number()
    .int()
    .min(0)
    .max(1_000_000)
    .optional()
    .describe(
      'Offset for pagination (slots only, pending_items). OPTIONAL for "slots". REJECTED for all other actions.'
    ),
  project_id: z
    .never({ error: 'project_id was removed; use cwd' })
    .optional()
    .describe('Removed; use cwd.'),
  cwd: z
    .string()
    .optional()
    .describe(
      'Working directory — resolves the project scope reported in meta.scope. OPTIONAL for "slots", "frontier" and "propose": omitting it leaves meta.scope null and is noted in meta.warnings (an unregistered path raises a global scope and its own warning). Without a registered scope, "slots" reads only the global slot rows and does not apply the project-scoped overrides, "frontier" answers across every project, and "propose" is never cross-project: the plan stays confined to the addressed thought\'s own project, or to the default project for a draft. ACCEPTED AND IGNORED for "config", "health".'
    ),
  thought_id: z
    .string()
    .optional()
    .describe(
      'Existing thought to analyse (provide this or content). OPTIONAL for "propose". REJECTED for all other actions.'
    ),
  content: z
    .string()
    .optional()
    .describe(
      'Draft content to analyse when the thought is not persisted yet (provide this or thought_id). OPTIONAL for "propose". REJECTED for all other actions.'
    ),
  compact: z
    .boolean()
    .optional()
    .describe(
      'Compact propose output (top 3 edges, no signals). Default true; pass false (or include_signals=true) for full output. OPTIONAL for "propose". REJECTED for all other actions.'
    ),
  max_edges: z.coerce
    .number()
    .int()
    .min(0)
    .optional()
    .describe(
      'Cap the number of proposed edges (maps to engine maxProposals). Default: 3 (slim) unless full output is requested. OPTIONAL for "propose". REJECTED for all other actions.'
    ),
  include_signals: z
    .boolean()
    .optional()
    .describe(
      'Include per-edge signals in the output. Default false (slim); true restores full output. OPTIONAL for "propose". REJECTED for all other actions.'
    ),
  severity: severitySchema
    .optional()
    .describe('Minimum severity. OPTIONAL for "health". REJECTED for all other actions.'),
  include_details: z
    .boolean()
    .optional()
    .describe(
      'Include per-check detail arrays in the health report (default false). OPTIONAL for "health". REJECTED for all other actions.'
    ),
  fields: z
    .array(z.string())
    .optional()
    .describe(
      'Fields to include in each slot row; intersected with the columns a slot offers. OPTIONAL for "slots". REJECTED for all other actions.'
    ),
  k: z.never({ error: 'k was removed; use limit' }).optional().describe('Removed; use limit.'),
  fix: z
    .never({ error: 'fix was removed; use /health-check/repair' })
    .optional()
    .describe('Removed; use the repair endpoint.')
}
