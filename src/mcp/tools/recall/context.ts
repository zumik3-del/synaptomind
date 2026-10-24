import { z } from 'zod/v4'
import { NotFoundError } from '../../../errors'
import { getChainService, getContextService } from '../../../services/graph.service'
import { resolveProjectId, shapeThought } from '../utils'
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
    const projectFilter = resolveProjectId(args.cwd as string | undefined)
    const maxDegree = args.max_degree as number | undefined
    const compact = args.compact === true
    const fields = args.fields

    const transformChain = (chain: any) => {
      if (!chain) return chain
      return {
        ...chain,
        thought: chain.thought ? shapeThought(chain.thought, compact, fields) : chain.thought,
        upstream: Array.isArray(chain.upstream)
          ? chain.upstream.map((e: any) => ({ ...e, thought: e?.thought ? shapeThought(e.thought, compact, fields) : e?.thought }))
          : chain.upstream,
        downstream: Array.isArray(chain.downstream)
          ? chain.downstream.map((e: any) => ({ ...e, thought: e?.thought ? shapeThought(e.thought, compact, fields) : e?.thought }))
          : chain.downstream,
      }
    }

    if (args.thought_id) {
      const chain = getChainService(
        args.thought_id as string,
        args.direction as 'upstream' | 'downstream' | 'both' | undefined,
        maxDegree
      )
      if (!chain) throw new NotFoundError(`Thought '${args.thought_id}' not found`)
      return { best_match: shapeThought(chain.thought, compact, fields), chain: transformChain(chain) }
    }

    const context = getContextService(args.query as string, maxDegree, projectFilter)
    if (!context) throw new NotFoundError(`No context found for query '${args.query}'`)
    return {
      best_match: shapeThought(context.best_match, compact, fields),
      chain: transformChain(context.chain)
    }
  }
}