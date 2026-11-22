import { NotFoundError } from '../../../errors'
import { getContextService } from '../../../services/graph.service'
import type { ChainResult } from '../../../services/graph.service'
import { itemEnvelope, readEnvelopeScope } from '../envelope'
import { actionInput, type ActionArgs, type ActionHandler } from '../action-tool'
import { chainOptions, chainView, shapeChainView } from './chain'
import { RECALL_ARGS } from './args'

const CONTEXT_REQUIRED = 'query or thought_id is required for context action'

export const contextHandler: ActionHandler = {
  input: actionInput(RECALL_ARGS, [
    'query',
    'thought_id',
    'cwd',
    'direction',
    'max_degree',
    'compact',
    'fields',
    'include_url_links'
  ]).refine(args => Boolean(args.query) || Boolean(args.thought_id), {
    message: CONTEXT_REQUIRED,
    path: ['query']
  }),
  async run(args: ActionArgs) {
    if (args.thought_id)
      return itemEnvelope('context', chainView(args.thought_id as string, chainOptions(args)))

    const { scope, warnings, projectId } = readEnvelopeScope(args.cwd)
    const context = await getContextService(args.query as string, {
      maxDegree: args.max_degree as number | undefined,
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
    const chain: ChainResult = context.chain ?? {
      thought: context.best_match,
      upstream: [],
      downstream: []
    }
    return itemEnvelope('context', shapeChainView(chain, chainOptions(args)), {
      scope,
      warnings,
      degraded: context.degraded === true
    })
  }
}
