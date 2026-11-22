import { getSlots } from '../../../services/slots.service'
import { shapeEntity } from '../utils'
import { collectionEnvelope, readEnvelopeScope } from '../envelope'
import { actionInput, type ActionArgs, type ActionHandler } from '../action-tool'
import { STATUS_ARGS } from './args'

const GLOBAL_ONLY_WARNING =
  'no project scope — the project-scoped slot overrides were not applied (pass cwd to read them)'

const SLOT_COLUMNS = [
  'name',
  'scope',
  'virtual',
  'content',
  'truncated',
  'max_chars',
  'updated_at'
] as const

export const slotsHandler: ActionHandler = {
  input: actionInput(STATUS_ARGS, ['names', 'slots_limit', 'offset', 'fields']),
  run(args: ActionArgs) {
    const { scope, warnings, projectId } = readEnvelopeScope(args.cwd)
    const slots = getSlots({
      names: args.names as string[] | undefined,
      projectId,
      limit: args.slots_limit as number | undefined,
      offset: args.offset as number | undefined
    })
    const items = slots.map(slot =>
      shapeEntity(slot, { compact: false, fields: args.fields, available: SLOT_COLUMNS })
    )
    return collectionEnvelope('slots', items, {
      scope,
      warnings: projectId === undefined ? [...warnings, GLOBAL_ONLY_WARNING] : warnings
    })
  }
}
