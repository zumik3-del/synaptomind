import { z } from 'zod/v4'
import { rollback as rollbackRun } from '../../../services/placement-rollback.service'
import { requiredString, type ActionArgs, type ActionHandler } from '../action-tool'
import { AGENT } from './apply'

export const rollbackHandler: ActionHandler = {
  input: z.object({ run_id: requiredString('run_id is required for rollback action') }),
  run(args: ActionArgs) {
    return rollbackRun(args.run_id as string, { confirm: args.confirm === true, decidedBy: AGENT })
  }
}
