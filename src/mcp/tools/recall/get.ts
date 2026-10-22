import { z } from 'zod/v4'
import { NotFoundError } from '../../../errors'
import { getThoughtByIdService } from '../../../services/thoughts.service'
import { getChainService } from '../../../services/graph.service'
import { requiredString, type ActionArgs, type ActionHandler } from '../action-tool'

/**
 * `memory_recall` action=get.
 *
 * Returns a single thought. When `include_edges` is true, incident edges are
 * returned inline (upstream/downstream, each with edge type + created_at) so a
 * caller can skip a separate `chain` call.
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
    if (!args.include_edges) return thought
    const chain = getChainService(id, 'both', args.max_degree as number | undefined)
    if (!chain) throw new NotFoundError(`Thought '${id}' not found`)
    return { ...thought, upstream: chain.upstream, downstream: chain.downstream }
  }
}