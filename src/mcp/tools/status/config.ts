import { buildConfigDisplay } from '../../../services/config-display.service'
import { itemEnvelope } from '../envelope'
import type { ActionHandler } from '../action-tool'

/**
 * `memory_status` action=config: the human-readable configuration display.
 *
 * The content channel keeps the raw text (it is meant to be read, not parsed);
 * `structuredContent.result` carries the standard envelope, so this is the one
 * action whose result is not a JSON mirror of `content[]` — `result.item.text`
 * is the same string.
 */
export const configHandler: ActionHandler = {
  run() {
    const text = buildConfigDisplay()
    return {
      content: [{ type: 'text' as const, text }],
      structuredContent: { result: itemEnvelope('config', { text }) }
    }
  }
}
