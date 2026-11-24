import { z } from 'zod/v4'
import type { McpServer } from '@modelcontextprotocol/server'
import { reflectSessionService } from '../../services/slots.service'
import { thoughtStatusSchema, timelineLimitSchema } from '../../validation'
import { itemEnvelope, writeEnvelopeScope } from './envelope'
import { resolveProjectId } from './utils'
import { ADDS_ONLY, actionInput, registerActionTool, type ActionArgs } from './action-tool'
import { listPage } from './list-page'

const REFLECT_ARGS = {
  summary: z
    .string()
    .optional()
    .describe(
      'Brief summary of what was accomplished. OPTIONAL for "reflect". REJECTED for "timeline".'
    ),
  goals_add: z
    .array(z.string())
    .optional()
    .describe(
      'Goals to add to active_goals — a goal already stored is not added twice. OPTIONAL for "reflect". REJECTED for "timeline".'
    ),
  goals_remove: z
    .array(z.string())
    .optional()
    .describe(
      'Goals to remove from active_goals — matched case-insensitively against the stored goals. OPTIONAL for "reflect". REJECTED for "timeline".'
    ),
  decisions: z
    .array(z.string())
    .optional()
    .describe(
      'Decisions made — creates active thoughts tagged "decision" and "reflect", skipping similar non-archived decisions and live content duplicates in the same project. OPTIONAL for "reflect". REJECTED for "timeline".'
    ),
  pending: z
    .array(z.string())
    .optional()
    .describe(
      'Pending tasks — creates draft thoughts tagged "pending" and "reflect" with a wake_days delay; existing live content in the same project is left unchanged. OPTIONAL for "reflect". REJECTED for "timeline".'
    ),
  wake_days: z.coerce
    .number()
    .int()
    .min(1)
    .max(365)
    .optional()
    .describe(
      'Days before pending items surface in the frontier (default 7, 1-365). OPTIONAL for "reflect". REJECTED for "timeline".'
    ),
  project_id: z
    .never({ error: 'project_id was removed; use cwd' })
    .optional()
    .describe('Removed; use cwd.'),
  cwd: z
    .string()
    .optional()
    .describe(
      'Working directory — resolves the project scope reported in meta.scope. OPTIONAL for both actions: reflect writes to the resolved project, or to the default project when it is absent; timeline answers across every project when it is absent and says so in meta.warnings.'
    ),
  status: thoughtStatusSchema
    .optional()
    .describe('Filter by status (default all). OPTIONAL for "timeline". REJECTED for "reflect".'),
  limit: timelineLimitSchema
    .optional()
    .describe('Max results (default 50, 1-500). OPTIONAL for "timeline". REJECTED for "reflect".'),
  offset: z.coerce
    .number()
    .int()
    .min(0)
    .max(1_000_000)
    .optional()
    .describe('Offset for pagination. OPTIONAL for "timeline". REJECTED for "reflect".'),
  compact: z
    .boolean()
    .optional()
    .describe(
      'Compact rows (default true): each timeline row keeps the minimal thought fields (id, content, status, tags as strings, project). compact=false returns the whole thought row. OPTIONAL for "timeline". REJECTED for "reflect".'
    ),
  fields: z
    .array(z.string())
    .optional()
    .describe(
      'Thought columns to include in each row; explicit fields win over compact. OPTIONAL for "timeline". REJECTED for "reflect".'
    ),
  include_url_links: z
    .boolean()
    .optional()
    .describe(
      'timeline only: when true, every row carries url_links — [{text, url, label}] ordered by sort_order then creation, all rows read in one query. Default false, where the key is absent; true with no links returns []. Never hidden by compact or fields. REJECTED for "reflect".'
    ),
  goals_delta: z
    .never({ error: 'goals_delta was removed; use goals_add / goals_remove' })
    .optional()
    .describe('Removed; use goals_add / goals_remove.')
}

const handlers = {
  reflect: {
    input: actionInput(REFLECT_ARGS, [
      'summary',
      'goals_add',
      'goals_remove',
      'decisions',
      'pending',
      'wake_days'
    ]),
    run(args: ActionArgs) {
      const projectId = resolveProjectId(args.cwd as string | undefined)
      const result = reflectSessionService({
        summary: args.summary as string | undefined,
        goals_add: args.goals_add as string[] | undefined,
        goals_remove: args.goals_remove as string[] | undefined,
        decisions: args.decisions as string[] | undefined,
        pending: args.pending as string[] | undefined,
        wake_days: args.wake_days as number | undefined,
        project_id: projectId
      })
      return itemEnvelope('reflect', result, writeEnvelopeScope(args.cwd))
    }
  },

  timeline: {
    input: actionInput(
      REFLECT_ARGS,
      ['status', 'limit', 'offset', 'compact', 'fields', 'include_url_links'],
      { status: z.enum(['draft', 'active', 'archived', 'all']).default('all') }
    ),
    run(args: ActionArgs) {
      return listPage('timeline', args)
    }
  }
}

export function registerMemoryReflect(server: McpServer) {
  registerActionTool(server, {
    name: 'memory_reflect',
    annotations: ADDS_ONLY,
    description: `Close a session: write down its decisions, pending items and goals, then read that log back. reflect is the session-level write path — row-level CRUD is memory_store, clustering memory_crystallize, retiring a thought memory_supersede. Actions: reflect (summary, decisions, pending, goals), timeline (the same inventory memory_recall action=list answers, surfaced here for session review; limit/offset and the total in meta.counts). cwd is optional for both: reflect treats it as a write scope (omitted, decisions/pending land in the default project and meta.scope is null), while timeline reads across every project and says so in meta.warnings. Answers { items, meta } for timeline and { item, meta } for reflect; meta = { action, scope, counts, degraded, warnings }. Actions accept only their own arguments.`,
    inputSchema: {
      action: z.enum(['reflect', 'timeline']).describe('Action'),
      ...REFLECT_ARGS
    },
    handlers
  })
}
