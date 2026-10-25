import { z } from 'zod/v4'
import { NotFoundError } from '../../../errors'
import { getChainService, getContextService } from '../../../services/graph.service'
import { shapeThought, shapeChain } from '../utils'
import { itemEnvelope, resolveEnvelopeScope, scopeProjectId } from '../envelope'
import type { ActionArgs, ActionHandler } from '../action-tool'

const CONTEXT_REQUIRED = 'query or thought_id is required for context action'

/**
 * `context` returns a thought plus its neighbourhood as `{ item: { thought,
 * chain }, meta }`. It accepts either a text `query` (best match + its chain)
 * or a `thought_id` (that thought + its chain, reusing the chain traversal
 * logic). At least one of the two must be supplied. With `thought_id` the call
 * is id-addressed and needs no `cwd`; the query path scopes to `cwd` when it is
 * given and reports the (global) scope in `meta` when it is not.
 *
 * The query path is deliberately ungated: it wants the single best match, so
 * the default relevance gate of the search surface would turn a weak-but-real
 * neighbourhood into "no match". `getContextService` therefore keeps
 * `minRelevance: 0` unless a caller opts in (task #2187).
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
  async run(args: ActionArgs) {
    const maxDegree = args.max_degree as number | undefined
    const compact = args.compact !== false
    const fields = args.fields

    if (args.thought_id) {
      const chain = getChainService(
        args.thought_id as string,
        args.direction as 'upstream' | 'downstream' | 'both' | undefined,
        maxDegree
      )
      if (!chain) throw new NotFoundError(`Thought '${args.thought_id}' not found`)
      // An id-addressed lookup is project-free, so it reports no scope and no
      // scope warning even when the caller passed a cwd.
      return itemEnvelope('context', {
        thought: shapeThought(chain.thought, compact, fields),
        chain: shapeChain(chain, compact, fields)
      })
    }

    const { scope, warnings } = resolveEnvelopeScope(args.cwd as string | undefined)
    const context = await getContextService(args.query as string, maxDegree, scopeProjectId(scope))
    if (!context) throw new NotFoundError(`No context found for query '${args.query}'`)
    if (!context.best_match) {
      // Degraded result with no best match: surface it as an empty item instead
      // of throwing, so `meta.reason` explains why nothing came back.
      return itemEnvelope('context', null, {
        scope,
        warnings,
        degraded: context.degraded === true,
        reason: 'no_match'
      })
    }
    return itemEnvelope('context', {
      thought: shapeThought(context.best_match, compact, fields),
      chain: shapeChain(context.chain, compact, fields)
    }, { scope, warnings, degraded: context.degraded === true })
  }
}
