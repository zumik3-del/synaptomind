import { getSlots } from '../../../services/slots.service'
import { projectFields, resolveProjectId } from '../utils'
import type { ActionArgs, ActionHandler } from '../action-tool'

export const slotsHandler: ActionHandler = {
  run(args: ActionArgs) {
    const projectFilter = resolveProjectId(args.cwd as string | undefined)
    const slots = getSlots({
      names: args.names as string[] | undefined,
      projectId: projectFilter,
      limit: (args.slots_limit ?? args.limit) as number | undefined,
      offset: args.offset as number | undefined
    })
    const fields = args.fields
    if (Array.isArray(fields) && fields.length > 0) {
      return slots.map((s: any) => projectFields(s, { fields }))
    }
    return slots
  }
}
