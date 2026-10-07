import { buildConfigDisplay } from '../../../services/config-display.service'
import { type ActionHandler } from '../action-tool'

export const configHandler: ActionHandler = {
  run() {
    const text = buildConfigDisplay()
    return { content: [{ type: 'text' as const, text }], structuredContent: { result: text } }
  }
}
