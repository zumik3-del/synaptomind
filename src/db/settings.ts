import type { Database } from 'bun:sqlite'
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

/**
 * Config-only soft limit: the value to advertise when no database is available.
 * Exported so the service layer can degrade to config when tool registration
 * runs before `initDb()` in some harnesses.
 */
export function configuredSoftLimit(): number {
  return positiveIntOr(config.thoughts.softLimit, DEFAULTS.thoughts.softLimit)
}

/**
 * Thought length limits. Config/env is the only source (task #2201): the `_meta`
 * runtime overrides (`thought_soft_limit`, `thought_hard_limit_buffer_percent`
 * and the legacy absolute `thought_hard_limit`) had no production writer, so the
 * resolution branch was removed.
 *
 * The connection stays in the signature because the thought and cluster services
 * pass their own connection through the DI convention; nothing is read from it.
 */
export function getThoughtLimitsDB(_db: Database): ThoughtLimits {
  const softLimit = configuredSoftLimit()
  const hardLimitBufferPercent = positiveIntOr(
    config.thoughts.hardLimitBufferPercent,
    DEFAULTS.thoughts.hardLimitBufferPercent
  )
  return { softLimit, hardLimitBufferPercent, hardLimit: deriveHardLimit(softLimit, hardLimitBufferPercent) }
}

// `getThoughtLimitsDB` is the implementation shared with the thought/cluster
// services; this entry point keeps the unsuffixed name for the settings service.
export function getThoughtLimits(db: Database): ThoughtLimits {
  return getThoughtLimitsDB(db)
}

// The limit advertised to agents in tool descriptions. The pre-init fallback
// lives in the service layer (getAdvertisedSoftLimitService): a db-first
// function has no database to fall back from.
export function getAdvertisedSoftLimit(db: Database): number {
  return getThoughtLimits(db).softLimit
}
