import { getSlots } from '../../../services/slots.service'
import { projectFields } from '../utils'
import { collectionEnvelope, readEnvelopeScope } from '../envelope'
import type { ActionArgs, ActionHandler } from '../action-tool'

/**
 * Raised when the call carries no project scope: the explicit slots then fall
 * back to their global rows, so the project-scoped overrides stay unread and
 * the answer would look complete without saying what it left out.
 */
const GLOBAL_ONLY_WARNING =
  'no project scope — the project-scoped slot overrides were not applied (pass cwd to read them)'

/**
 * `memory_status` action=slots: `{ items, meta }`, one item per slot. `cwd` is
 * optional: without it the explicit slots answer their global rows, so the
 * overrides warning declares what the answer left out. A present (even
 * unregistered) cwd keeps its pre-#2445 answer, so the warning is cwd-less only.
 */
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
    const hasCwd = typeof args.cwd === 'string' && args.cwd.trim().length > 0
    return collectionEnvelope('slots', items, {
      scope,
      warnings: hasCwd ? warnings : [...warnings, GLOBAL_ONLY_WARNING]
    })
  }
}
