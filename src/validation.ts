import type { ThoughtLimits } from './db/settings'
import { insertLog } from './logging/log'
import { ValidationError } from './services/errors'
import { isThoughtStatus } from './types/thought'

export function validateStatus(status: string | undefined): void {
  if (status !== undefined && !isThoughtStatus(status)) {
    throw new ValidationError(`Invalid status: ${status}. Must be one of: draft, active, archived`)
  }
}

export function validateContentLength(content: string, limits: ThoughtLimits, thoughtId?: string): void {
  const { softLimit, hardLimit } = limits
  if (content.length > hardLimit) {
    throw new ValidationError(
      `Thought content exceeds hard limit of ${hardLimit} chars (got ${content.length}). ` +
        `Please split it into smaller atomic thoughts or raise the hard limit in Settings.`
    )
  }
  if (content.length > softLimit) {
    insertLog(
      'warning',
      'thought',
      `Thought content exceeds soft limit of ${softLimit} chars (got ${content.length})`,
      {
        thought_id: thoughtId,
        length: content.length
      }
    )
  }
}
