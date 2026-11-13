import { getGraphDataService } from '../../../services/graph.service'
import { collectionEnvelope, readEnvelopeScope } from '../envelope'
import { projectFields } from '../utils'
import type { ActionArgs, ActionHandler } from '../action-tool'

export const graphHandler: ActionHandler = {
  run(args: ActionArgs) {
    const { scope, warnings, projectId } = readEnvelopeScope(args.cwd)
    const data = getGraphDataService(
      projectId,
      args.status as string | undefined,
      args.limit as number | undefined,
      args.offset as number | undefined
    )
    const fields = args.fields
    if (Array.isArray(fields) && fields.length > 0) {
      data.nodes = data.nodes.map(n => projectFields(n, { fields })) as unknown as typeof data.nodes
      data.edges = data.edges.map(e => projectFields(e, { fields })) as unknown as typeof data.edges
    }
    const total = typeof data.total === 'number' ? data.total : data.nodes.length
    const envelope = collectionEnvelope('graph', data.nodes, {
      scope,
      warnings,
      total,
      filtered_out: Math.max(0, total - data.nodes.length),
      counts: { edges: data.edges.length }
    })
    return { items: envelope.items, edges: data.edges, meta: envelope.meta }
  }
}
