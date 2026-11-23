import { NotFoundError } from '../../../errors'
import { getChainService, type ChainResult } from '../../../services/graph.service'
import { loadUrlLinks, shapeChain, type ShapeOptions } from '../utils'

interface ChainViewOptions extends ShapeOptions {
  direction?: 'upstream' | 'downstream' | 'both'
  maxDegree?: number
  includeUrlLinks?: boolean
}

export function chainOptions(args: Record<string, unknown>): ChainViewOptions {
  return {
    direction: args.direction as ChainViewOptions['direction'],
    maxDegree: args.max_degree as number | undefined,
    compact: args.compact !== false,
    fields: args.fields,
    includeUrlLinks: args.include_url_links === true
  }
}

// One path shapes every chain the recall tool answers — action=chain and the thought_id form of
// action=context — including the url links of the head and both neighbourhoods.
export function shapeChainView(chain: ChainResult, options: ChainViewOptions): ChainResult {
  const urlLinks =
    options.includeUrlLinks === true
      ? loadUrlLinks([
          chain.thought,
          ...chain.upstream.map(e => e.thought),
          ...chain.downstream.map(e => e.thought)
        ])
      : undefined
  return shapeChain(chain, {
    compact: options.compact,
    fields: options.fields,
    urlLinks
  }) as ChainResult
}

export function chainView(thoughtId: string, options: ChainViewOptions): ChainResult {
  const chain = getChainService(thoughtId, options.direction, options.maxDegree)
  if (!chain) throw new NotFoundError(`Thought '${thoughtId}' not found`)
  return shapeChainView(chain, options)
}
