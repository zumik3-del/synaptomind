import { z } from 'zod/v4'
import { proposePlacementPlan } from '../../../services/placement/engine'
import { itemEnvelope, requireEnvelopeScope } from '../envelope'
import type { ActionArgs, ActionHandler } from '../action-tool'

/** `memory_status` action=propose: `{ item: <plan>, meta }`; `cwd` is required. */
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
    const { scope, warnings, projectId } = requireEnvelopeScope(args.cwd, 'memory_status', 'propose')
    // Slim is now the default (top-3 edges, no signals). Full output is
    // restored by include_signals=true or compact=false.
    const full = args.compact === false || args.include_signals === true
    const compact = !full
    const maxEdges =
      typeof args.max_edges === 'number'
        ? args.max_edges
        : compact
          ? 3
          : undefined
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
      plan.edges = plan.edges.map(({ signals: _signals, ...rest }) => rest as typeof plan.edges[number])
    }
    // Slim is a shorthand for top-3; enforce the cap when no explicit
    // max_edges was provided.
    if (compact && typeof args.max_edges !== 'number' && plan.edges.length > 3) {
      plan.edges = plan.edges.slice(0, 3)
    }
    return itemEnvelope('propose', plan, {
      scope,
      warnings,
      degraded: plan.degraded === true,
      total: plan.edges.length
    })
  }
}
