import { getSlots } from '../../../services/slots.service'
import { projectFields } from '../utils'
import { collectionEnvelope, requireEnvelopeScope } from '../envelope'
import type { ActionArgs, ActionHandler } from '../action-tool'

/**
 * `memory_status` action=slots: `{ items, meta }`, one item per slot. `cwd` is
 * required — the project-scoped slot rows win over the global fallback, so a
 * missing scope would silently answer with the wrong rows.
 */
export const slotsHandler: ActionHandler = {
  run(args: ActionArgs) {
    const { scope, warnings, projectId } = requireEnvelopeScope(args.cwd, 'memory_status', 'slots')
    const slots = getSlots({
      names: args.names as string[] | undefined,
      projectId,
      limit: (args.slots_limit ?? args.limit) as number | undefined,
      offset: args.offset as number | undefined
    })
    const fields = args.fields
    const items = Array.isArray(fields) && fields.length > 0
      ? (slots.map((s) => projectFields(s, { fields })) as unknown as typeof slots)
      : slots
    return collectionEnvelope('slots', items, { scope, warnings })
  }
}
