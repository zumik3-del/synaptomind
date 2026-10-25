import { getGraphDataService } from '../../../services/graph.service'
import { collectionEnvelope, resolveEnvelopeScope, scopeProjectId } from '../envelope'
import { projectFields } from '../utils'
import type { ActionArgs, ActionHandler } from '../action-tool'

/**
 * `memory_crystallize action=graph` — the one envelope exception (task #2181).
 *
 * A graph is two collections, not one: the nodes are `items` and the edges ride
 * beside them as a named `edges` field, because interleaving them in one array
 * would force every caller to filter by shape. Every other action of the MCP
 * surface stays `{ item, meta }` / `{ items, meta }`.
 *
 * `cwd` is optional here (task #2187): the scope is resolved through the shared
 * read-side helper like every other read, so a cwd-less or unregistered call
 * answers globally and says so in `meta.warnings` instead of silently spanning
 * projects with no trace.
 */
export const graphHandler: ActionHandler = {
  run(args: ActionArgs) {
    const { scope, warnings } = resolveEnvelopeScope(args.cwd as string | undefined)
    const data = getGraphDataService(scopeProjectId(scope), args.status as string | undefined, args.limit as number | undefined, args.offset as number | undefined)
    const fields = args.fields
    if (Array.isArray(fields) && fields.length > 0) {
      data.nodes = data.nodes.map((n) => projectFields(n, { fields })) as unknown as typeof data.nodes
      data.edges = data.edges.map((e) => projectFields(e, { fields })) as unknown as typeof data.edges
    }
    const envelope = collectionEnvelope('graph', data.nodes, {
      scope,
      warnings,
      total: typeof data.total === 'number' ? data.total : data.nodes.length,
      counts: { edges: data.edges.length }
    })
    return { items: envelope.items, edges: data.edges, meta: envelope.meta }
  }
}
