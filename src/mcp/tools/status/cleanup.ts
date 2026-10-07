import { cleanupArchivedThoughts } from '../../../services/ttl-cleanup.service'
import { type ActionArgs, type ActionHandler } from '../action-tool'

export const cleanupHandler: ActionHandler = {
  run(args: ActionArgs) {
    return cleanupArchivedThoughts((args.dry_run as boolean | undefined) ?? true)
  }
}
