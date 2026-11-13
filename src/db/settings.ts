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
