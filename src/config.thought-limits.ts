import { type Config, config, DEFAULTS } from './config'

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

export function getThoughtLimitsDB(cfg: Config = config): ThoughtLimits {
  const softLimit = positiveIntOr(cfg.thoughts.softLimit, DEFAULTS.thoughts.softLimit)
  const hardLimitBufferPercent = positiveIntOr(
    cfg.thoughts.hardLimitBufferPercent,
    DEFAULTS.thoughts.hardLimitBufferPercent
  )
  return {
    softLimit,
    hardLimitBufferPercent,
    hardLimit: deriveHardLimit(softLimit, hardLimitBufferPercent)
  }
}
