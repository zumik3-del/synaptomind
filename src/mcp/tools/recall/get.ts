import { z } from 'zod/v4'
import { NotFoundError } from '../../../errors'
import { getThoughtByIdService } from '../../../services/thoughts.service'
import { getChainService } from '../../../services/graph.service'
import { shapeEntity, loadUrlLinks } from '../utils'
import { itemEnvelope } from '../envelope'
import type { Thought } from '../../../db/thoughts'
import { actionInput, requiredString, type ActionArgs, type ActionHandler } from '../action-tool'
import { RECALL_ARGS } from './args'

export const getHandler: ActionHandler = {
  input: actionInput(
    RECALL_ARGS,
    ['thought_id', 'include_edges', 'max_degree', 'compact', 'fields', 'include_url_links'],
    { thought_id: requiredString('thought_id is required for get action') }
  ),
  run(args: ActionArgs) {
    const id = args.thought_id as string
    const thought = getThoughtByIdService(id)
    if (!thought) throw new NotFoundError(`Thought '${id}' not found`)
    const compact = args.compact !== false
    const fields = args.fields
    const chain = args.include_edges
      ? getChainService(id, 'both', args.max_degree as number | undefined)
      : null
    if (args.include_edges && !chain) throw new NotFoundError(`Thought '${id}' not found`)
    const urlLinks =
      args.include_url_links === true
        ? loadUrlLinks([
            thought,
            ...(chain?.upstream ?? []).map(e => e.thought),
            ...(chain?.downstream ?? []).map(e => e.thought)
          ])
        : undefined
    const shaped = shapeEntity(thought, { compact, fields, urlLinks }) as Thought
    if (!chain) return itemEnvelope('get', shaped)
    const edges = (list: unknown): unknown =>
      Array.isArray(list)
        ? list.map((e: { edge: unknown; thought?: Thought }) => ({
            ...e,
            thought: e?.thought ? shapeEntity(e.thought, { compact, fields, urlLinks }) : e?.thought
          }))
        : list
    return itemEnvelope('get', {
      ...shaped,
      upstream: edges(chain.upstream),
      downstream: edges(chain.downstream)
    })
  }
}
