import { getSlots } from '../../../services/slots.service'
import { resolveProjectId } from '../utils'
import { type ActionArgs, type ActionHandler } from '../action-tool'

export const slotsHandler: ActionHandler = {
  run(args: ActionArgs) {
    const projectFilter = resolveProjectId(args.project_id as string | undefined, args.cwd as string | undefined)
    return getSlots({ names: args.names as string[] | undefined, projectId: projectFilter })
  }
}
