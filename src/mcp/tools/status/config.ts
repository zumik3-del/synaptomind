import { buildConfigDisplay } from '../../../services/config-display.service'
import { itemEnvelope } from '../envelope'
import { actionInput, type ActionHandler } from '../action-tool'
import { STATUS_ARGS } from './args'

export const configHandler: ActionHandler = {
  input: actionInput(STATUS_ARGS, []),
  run() {
    const text = buildConfigDisplay()
    return {
      content: [{ type: 'text' as const, text }],
      structuredContent: { result: itemEnvelope('config', { text }) }
    }
  }
}
