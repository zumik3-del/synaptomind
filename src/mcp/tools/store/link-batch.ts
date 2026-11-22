import { createEdgesBatchService, type LinkBatchItem } from '../../../services/edges.service'
import { collectionEnvelope } from '../envelope'
import { actionInput, type ActionArgs, type ActionHandler } from '../action-tool'
import { STORE_ARGS } from './args'
import { linksArg } from './items'

interface LinkBatchRow {
  index: number
  status: 'linked' | 'failed'
  source: string
  target: string
  type?: string
  error?: string
}

export const linkBatchHandler: ActionHandler = {
  input: actionInput(STORE_ARGS, ['links'], { links: linksArg }),
  run(args: ActionArgs) {
    const links = args.links as LinkBatchItem[]
    const result = createEdgesBatchService(links)
    const failures = new Map(result.errors.map(error => [error.index, error.error]))
    const rows: LinkBatchRow[] = links.map((link, index) => {
      const error = failures.get(index)
      const row: LinkBatchRow = {
        index,
        status: error === undefined ? 'linked' : 'failed',
        source: link.source,
        target: link.target
      }
      if (link.type !== undefined) row.type = link.type
      if (error !== undefined) row.error = error
      return row
    })
    return collectionEnvelope('link_batch', rows, {
      total: links.length,
      counts: { linked: result.linked, failed: result.failed }
    })
  }
}
