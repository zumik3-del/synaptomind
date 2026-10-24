import type { BulkCreateItem } from '../../../services/bulk.service'
import { bulkCreateThoughtsService } from '../../../services/bulk.service'
import { resolveProjectId } from '../utils'
import type { ActionArgs, ActionHandler } from '../action-tool'

export const bulkCreateHandler: ActionHandler = {
  run(args: ActionArgs) {
    const items = args.thoughts as BulkCreateItem[] | undefined
    const defaultProjectId = resolveProjectId(args.cwd as string | undefined)
    const { created, errors } = bulkCreateThoughtsService(items, defaultProjectId)
    return {
      created: created.length,
      errors: errors.length,
      thoughts: created.map((item) => item.thought),
      error_details: errors.length > 0 ? errors : undefined
    }
  }
}
