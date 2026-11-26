import { listThoughtsPageService, type Thought } from '../../services/thoughts.service'
import { collectionEnvelope, readEnvelopeScope } from './envelope'
import { loadUrlLinks, shapeEntity } from './utils'
import type { ActionArgs } from './action-tool'

// The paginated thought inventory behind memory_recall action=list.
export function listPage(args: ActionArgs) {
  const { scope, warnings, projectId } = readEnvelopeScope(args.cwd)
  const page = listThoughtsPageService({
    status: args.status as 'draft' | 'active' | 'archived' | 'all' | undefined,
    project_id: projectId,
    tag: args.tag as string | undefined,
    is_cluster: args.is_cluster as boolean | undefined,
    limit: args.limit as number | undefined,
    offset: args.offset as number | undefined
  })
  const urlLinks = args.include_url_links === true ? loadUrlLinks(page.thoughts) : undefined
  const items = page.thoughts.map((t: Thought) =>
    shapeEntity(t, { compact: args.compact !== false, fields: args.fields, urlLinks })
  )
  return collectionEnvelope('list', items, {
    scope,
    warnings,
    total: page.total,
    filtered_out: Math.max(0, page.total - items.length),
    counts: { limit: page.limit ?? 0, offset: page.offset }
  })
}
