import { z } from 'zod/v4'
import { NotFoundError } from '../../../errors'
import { getThoughtByIdService } from '../../../services/thoughts.service'
import { getChainService } from '../../../services/graph.service'
import { shapeThought } from '../utils'
import { itemEnvelope } from '../envelope'
import type { Thought } from '../../../db/thoughts'
import { requiredString, type ActionArgs, type ActionHandler } from '../action-tool'

/**
 * `memory_recall` action=get.
 *
 * Returns one thought as `{ item, meta }`. When `include_edges` is true,
 * incident edges are returned inline inside the item (upstream/downstream, each
 * with edge type + created_at) so a caller can skip a separate `chain` call.
 * Edges are not thought columns, so `compact`/`fields` never trim them away:
 * they shape only the thought objects inside the edge entries.
 */
export const getHandler: ActionHandler = {
  input: z.object({
    thought_id: requiredString('thought_id is required for get action'),
    include_edges: z.boolean().optional(),
    max_degree: z.coerce.number().int().min(1).max(200).optional()
  }),
  run(args: ActionArgs) {
    const id = args.thought_id as string
    const thought = getThoughtByIdService(id)
    if (!thought) throw new NotFoundError(`Thought '${id}' not found`)
    const compact = args.compact !== false
    const fields = args.fields
    const shaped = shapeThought(thought, compact, fields) as Thought
    if (!args.include_edges) return itemEnvelope('get', shaped)
    const chain = getChainService(id, 'both', args.max_degree as number | undefined)
    if (!chain) throw new NotFoundError(`Thought '${id}' not found`)
    const edges = (list: unknown): unknown =>
      Array.isArray(list)
        ? list.map((e: { edge: unknown; thought?: Thought }) => ({ ...e, thought: e?.thought ? shapeThought(e.thought, compact, fields) : e?.thought }))
        : list
    return itemEnvelope('get', {
      ...shaped,
      upstream: edges(chain.upstream),
      downstream: edges(chain.downstream)
    })
  }
}
