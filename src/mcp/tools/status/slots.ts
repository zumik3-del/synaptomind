import { getSlots } from '../../../services/slots.service'
import { projectFields } from '../utils'
import { collectionEnvelope, readEnvelopeScope } from '../envelope'
import type { ActionArgs, ActionHandler } from '../action-tool'

const GLOBAL_ONLY_WARNING =
  'no project scope — the project-scoped slot overrides were not applied (pass cwd to read them)'

export const slotsHandler: ActionHandler = {
  run(args: ActionArgs) {
    const { scope, warnings, projectId } = readEnvelopeScope(args.cwd)
    const slots = getSlots({
      names: args.names as string[] | undefined,
      projectId,
      limit: (args.slots_limit ?? args.limit) as number | undefined,
      offset: args.offset as number | undefined
    })
    const fields = args.fields
    const items =
      Array.isArray(fields) && fields.length > 0
        ? (slots.map(s => projectFields(s, { fields })) as unknown as typeof slots)
        : slots
    return collectionEnvelope('slots', items, {
      scope,
      warnings: projectId === undefined ? [...warnings, GLOBAL_ONLY_WARNING] : warnings
    })
  }
}
