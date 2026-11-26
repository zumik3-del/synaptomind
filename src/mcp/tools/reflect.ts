import { z } from 'zod/v4'
import type { McpServer } from '@modelcontextprotocol/server'
import { reflectSessionService } from '../../services/slots.service'
import { itemEnvelope, writeEnvelopeScope } from './envelope'
import { resolveProjectId } from './utils'
import { ADDS_ONLY, actionInput, registerActionTool, type ActionArgs } from './action-tool'

const REFLECT_ARGS = {
  summary: z
    .string()
    .optional()
    .describe('Brief summary of what was accomplished. OPTIONAL for "reflect".'),
  goals_add: z
    .array(z.string())
    .optional()
    .describe(
      'Goals to add to active_goals — a goal already stored is not added twice. OPTIONAL for "reflect".'
    ),
  goals_remove: z
    .array(z.string())
    .optional()
    .describe(
      'Goals to remove from active_goals — matched case-insensitively against the stored goals. OPTIONAL for "reflect".'
    ),
  decisions: z
    .array(z.string())
    .optional()
    .describe(
      'Decisions made — creates active thoughts tagged "decision" and "reflect", skipping similar non-archived decisions and live content duplicates in the same project. OPTIONAL for "reflect".'
    ),
  pending: z
    .array(z.string())
    .optional()
    .describe(
      'Pending tasks — creates draft thoughts tagged "pending" and "reflect" with a wake_days delay; existing live content in the same project is left unchanged. OPTIONAL for "reflect".'
    ),
  wake_days: z.coerce
    .number()
    .int()
    .min(1)
    .max(365)
    .optional()
    .describe(
      'Days before pending items surface in the frontier (default 7, 1-365). OPTIONAL for "reflect".'
    ),
  project_id: z
    .never({ error: 'project_id was removed; use cwd' })
    .optional()
    .describe('Removed; use cwd.'),
  cwd: z
    .string()
    .optional()
    .describe(
      'Working directory — resolves the project scope reported in meta.scope. OPTIONAL for "reflect": it is a write scope, so decisions/pending land in the resolved project, or in the default project when it is absent (meta.scope is then null).'
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
  }
}

export function registerMemoryReflect(server: McpServer) {
  registerActionTool(server, {
    name: 'memory_reflect',
    annotations: ADDS_ONLY,
    description: `Close a session: write down its decisions, pending items and goals. Reflect is the session-level write path — row-level CRUD is memory_store, clustering memory_crystallize, retiring a thought memory_supersede. Actions: reflect (summary, decisions, pending, goals). cwd is a write scope: omitted, decisions/pending land in the default project and meta.scope is null. Answers { item, meta }.`,
    inputSchema: {
      action: z.enum(['reflect']).describe('Action'),
      ...REFLECT_ARGS
    },
    handlers,
    retiredActions: {
      timeline: 'timeline was removed; use memory_recall action=list'
    }
  })
}
