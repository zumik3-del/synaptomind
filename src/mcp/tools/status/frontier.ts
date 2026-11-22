import { getFrontierService } from '../../../services/frontier.service'
import { collectionEnvelope, readEnvelopeScope } from '../envelope'
import { actionInput, type ActionArgs, type ActionHandler } from '../action-tool'
import { STATUS_ARGS } from './args'

export const frontierHandler: ActionHandler = {
  input: actionInput(STATUS_ARGS, ['limit']),
  run(args: ActionArgs) {
    const { scope, warnings, projectId } = readEnvelopeScope(args.cwd)
    const { items } = getFrontierService({
      project_id: projectId,
      k: args.limit as number | undefined
    })
    return collectionEnvelope('frontier', items, { scope, warnings })
  }
}
