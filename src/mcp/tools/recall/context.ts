import { z } from 'zod/v4'
import { NotFoundError } from '../../../errors'
import { getChainService, getContextService } from '../../../services/graph.service'
import { resolveProjectId } from '../utils'
import type { ActionArgs, ActionHandler } from '../action-tool'

const CONTEXT_REQUIRED = 'query or thought_id is required for context action'

/**
 * `context` returns a thought plus its neighbourhood. It accepts either a text
 * `query` (best match + its chain) or a `thought_id` (that thought + its chain,
 * reusing the chain traversal logic). At least one of the two must be supplied.
 */
export const contextHandler: ActionHandler = {
  input: z
    .object({
      query: z.string().optional(),
      thought_id: z.string().optional()
    })
    .superRefine((args, ctx) => {
      if (!args.query && !args.thought_id) {
        ctx.addIssue({ code: 'custom', message: CONTEXT_REQUIRED, path: ['query'] })
      }
    }),
  run(args: ActionArgs) {
    const projectFilter = resolveProjectId(args.project_id as string | undefined, args.cwd as string | undefined)
    const maxDegree = args.max_degree as number | undefined

    if (args.thought_id) {
      const chain = getChainService(
        args.thought_id as string,
        args.direction as 'upstream' | 'downstream' | 'both' | undefined,
        maxDegree
      )
      if (!chain) throw new NotFoundError(`Thought '${args.thought_id}' not found`)
      return { best_match: chain.thought, chain }
    }

    const context = getContextService(args.query as string, maxDegree, projectFilter)
    if (!context) throw new NotFoundError(`No context found for query '${args.query}'`)
    return context
  }
}