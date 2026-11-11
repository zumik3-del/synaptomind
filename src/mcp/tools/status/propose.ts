import { z } from 'zod/v4'
import { proposePlacementPlan } from '../../../services/placement/engine'
import { type EnvelopeScope, itemEnvelope, readEnvelopeScope } from '../envelope'
import type { ActionArgs, ActionHandler } from '../action-tool'

/** Why `propose` never widens, named for the input the plan pins its project from. */
function pinningNote(args: ActionArgs): string {
  if (args.thought_id !== undefined) {
    return 'propose is not cross-project: the plan is restricted to the project the addressed thought (thought_id) belongs to'
  }
  return 'propose is not cross-project: the plan is restricted to the default project (draft content)'
}

/**
 * Notes for `propose`, keyed on whether a project actually resolved (tasks #2453/#2456).
 *
 * The planner pins its project whenever no project filter reaches it, so the
 * pinning note belongs to `projectId === undefined` rather than to a missing
 * scope. Both cases restate the cause locally, because the generic
 * "the answer spans every project" note is false for this action: no `cwd` reads
 * `no cwd — ...`, and a present-but-unregistered `cwd` keeps only the
 * unknown-path fact (with its resolve hint) followed by the pinning clause.
 */
function proposeWarnings(
  args: ActionArgs,
  scope: EnvelopeScope | null,
  warnings: string[],
  projectId: string | undefined
): string[] {
  if (projectId !== undefined) return warnings
  const note = pinningNote(args)
  if (scope === null) return [`no cwd — ${note}`]
  return [
    `cwd "${String(args.cwd)}" matches no known project (check it with memory_manage action=resolve) — ${note}`
  ]
}

/** `memory_status` action=propose: `{ item: <plan>, meta }`; `cwd` is optional. */
export const proposeHandler: ActionHandler = {
  input: z
    .object({
      thought_id: z.string().optional(),
      content: z.string().optional(),
      compact: z.boolean().optional(),
      max_edges: z.number().int().min(0).optional(),
      include_signals: z.boolean().optional()
    })
    .refine(v => v.thought_id !== undefined || v.content !== undefined, {
      message: 'provide thought_id (existing thought) or content (draft)',
      path: ['thought_id']
    }),
  async run(args: ActionArgs) {
    const { scope, warnings, projectId } = readEnvelopeScope(args.cwd)
    // Slim is now the default (top-3 edges, no signals). Full output is
    // restored by include_signals=true or compact=false.
    const full = args.compact === false || args.include_signals === true
    const compact = !full
    const maxEdges = typeof args.max_edges === 'number' ? args.max_edges : compact ? 3 : undefined
    const includeSignals =
      typeof args.include_signals === 'boolean' ? args.include_signals : !compact

    const plan = await proposePlacementPlan(
      {
        thoughtId: args.thought_id as string | undefined,
        content: args.content as string | undefined,
        projectId
      },
      {
        projectId,
        ...(typeof maxEdges === 'number' ? { maxProposals: maxEdges } : {})
      }
    )

    if (!includeSignals) {
      plan.edges = plan.edges.map(
        ({ signals: _signals, ...rest }) => rest as (typeof plan.edges)[number]
      )
    }
    // Slim is a shorthand for top-3; enforce the cap when no explicit
    // max_edges was provided.
    if (compact && typeof args.max_edges !== 'number' && plan.edges.length > 3) {
      plan.edges = plan.edges.slice(0, 3)
    }
    return itemEnvelope('propose', plan, {
      scope,
      warnings: proposeWarnings(args, scope, warnings, projectId),
      degraded: plan.degraded === true,
      total: plan.edges.length
    })
  }
}
