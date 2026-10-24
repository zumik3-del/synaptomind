import { z } from 'zod/v4'
import { proposePlacementPlan } from '../../../services/placement/engine'
import { resolveProjectId } from '../utils'
import type { ActionArgs, ActionHandler } from '../action-tool'

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
    const projectFilter = resolveProjectId(args.project_id as string | undefined, args.cwd as string | undefined)
    const compact = args.compact === true
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
        projectId: projectFilter
      },
      {
        projectId: projectFilter,
        ...(typeof maxEdges === 'number' ? { maxProposals: maxEdges } : {})
      }
    )

    if (!includeSignals) {
      plan.edges = plan.edges.map(({ signals: _signals, ...rest }) => rest as typeof plan.edges[number])
    }
    // compact is a shorthand for top-3 + no signals; enforce the top-3 cap
    // even when max_edges was not explicitly provided.
    if (compact && plan.edges.length > 3) {
      plan.edges = plan.edges.slice(0, 3)
    }
    return plan
  }
}
