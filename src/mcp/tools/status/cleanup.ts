import { cleanupArchivedThoughts } from '../../../services/ttl-cleanup.service'
import type { ActionArgs, ActionHandler } from '../action-tool'

export const cleanupHandler: ActionHandler = {
  run(args: ActionArgs) {
    return cleanupArchivedThoughts(!(args.confirm as boolean | undefined))
  }
}
