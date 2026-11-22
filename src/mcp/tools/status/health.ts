import { runHealthCheckView } from '../../../services/health-check.service'
import type { Severity } from '../../../services/health-check.service'
import { itemEnvelope } from '../envelope'
import { actionInput, type ActionArgs, type ActionHandler } from '../action-tool'
import { STATUS_ARGS } from './args'

const CONTENT_LIMIT = 80

export const healthHandler: ActionHandler = {
  input: actionInput(STATUS_ARGS, ['severity', 'include_details']),
  run(args: ActionArgs) {
    const view = runHealthCheckView({
      severity: args.severity as Severity | undefined,
      details: args.include_details === true,
      contentLimit: CONTENT_LIMIT
    })
    return itemEnvelope('health', view)
  }
}
