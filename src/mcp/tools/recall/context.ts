import { z } from 'zod/v4'
import { NotFoundError } from '../../../errors'
import { getChainService, getContextService } from '../../../services/graph.service'
import { shapeThought, shapeChain, loadUrlLinks } from '../utils'
import { itemEnvelope, readEnvelopeScope } from '../envelope'
import type { ActionArgs, ActionHandler } from '../action-tool'

const CONTEXT_REQUIRED = 'query or thought_id is required for context action'

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
      const urlLinks =
        args.include_url_links === true
          ? loadUrlLinks([
              chain.thought,
              ...chain.upstream.map(e => e.thought),
              ...chain.downstream.map(e => e.thought)
            ])
          : undefined
      return itemEnvelope('context', {
        thought: shapeThought(chain.thought, compact, fields, urlLinks),
        chain: shapeChain(chain, compact, fields, urlLinks)
      })
    }

    const { scope, warnings, projectId } = readEnvelopeScope(args.cwd)
    const context = await getContextService(args.query as string, {
      maxDegree,
      projectFilter: projectId
    })
    if (!context) throw new NotFoundError(`No context found for query '${args.query}'`)
    if (!context.best_match) {
      return itemEnvelope('context', null, {
        scope,
        warnings,
        degraded: context.degraded === true,
        reason: 'no_match'
      })
    }
    const urlLinks =
      args.include_url_links === true
        ? loadUrlLinks([
            context.best_match,
            ...(context.chain?.upstream ?? []).map(e => e.thought),
            ...(context.chain?.downstream ?? []).map(e => e.thought)
          ])
        : undefined
    return itemEnvelope(
      'context',
      {
        thought: shapeThought(context.best_match, compact, fields, urlLinks),
        chain: shapeChain(context.chain, compact, fields, urlLinks)
      },
      { scope, warnings, degraded: context.degraded === true }
    )
  }
}
