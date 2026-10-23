import { getSlots } from '../../../services/slots.service'
import { resolveProjectId } from '../utils'
import type { ActionArgs, ActionHandler } from '../action-tool'

export const slotsHandler: ActionHandler = {
  run(args: ActionArgs) {
    const projectFilter = resolveProjectId(args.project_id as string | undefined, args.cwd as string | undefined)
    return getSlots({
      names: args.names as string[] | undefined,
      projectId: projectFilter,
      limit: (args.slots_limit ?? args.limit) as number | undefined,
      offset: args.offset as number | undefined
    })
  }
}
