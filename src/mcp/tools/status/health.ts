import { runHealthCheckService } from '../../../services/health-check.service'
import { type ActionArgs, type ActionHandler } from '../action-tool'

export const healthHandler: ActionHandler = {
  run(args: ActionArgs) {
    return runHealthCheckService({ severity: args.severity as 'critical' | 'warning' | 'info' | undefined, fix: args.fix as boolean | undefined })
  }
}
