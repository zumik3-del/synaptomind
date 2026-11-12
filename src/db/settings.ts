import { config, DEFAULTS } from '../config'

export interface ThoughtLimits {
  softLimit: number
  hardLimit: number
  hardLimitBufferPercent: number
}

function positiveIntOr(value: number, fallback: number): number {
  return Number.isInteger(value) && value > 0 ? value : fallback
}

function deriveHardLimit(softLimit: number, hardLimitBufferPercent: number): number {
  return Math.round(softLimit * (1 + hardLimitBufferPercent / 100))
}

function configuredSoftLimit(): number {
  return positiveIntOr(config.thoughts.softLimit, DEFAULTS.thoughts.softLimit)
}

/**
 * Thought length limits. Config/env is the only source (task #2201): the `_meta`
 * runtime overrides (`thought_soft_limit`, `thought_hard_limit_buffer_percent`
 * and the legacy absolute `thought_hard_limit`) had no production writer, so the
 * resolution branch was removed. The computation reads no database, so it takes
 * no connection (finding F7).
 */
export function getThoughtLimitsDB(): ThoughtLimits {
  const softLimit = configuredSoftLimit()
  const hardLimitBufferPercent = positiveIntOr(
    config.thoughts.hardLimitBufferPercent,
    DEFAULTS.thoughts.hardLimitBufferPercent
  )
  return {
    softLimit,
    hardLimitBufferPercent,
    hardLimit: deriveHardLimit(softLimit, hardLimitBufferPercent)
  }
}
