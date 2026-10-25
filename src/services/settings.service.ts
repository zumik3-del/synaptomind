import type { Database } from 'bun:sqlite'
import { getDb } from '../db/container'
import {
  configuredSoftLimit,
  getAdvertisedSoftLimit as resolveAdvertisedSoftLimit
} from '../db/settings'

/**
 * Thin service wrappers over the runtime-settings meta accessors. They keep the
 * API/tool layers free of direct db access (findings F2/#1) and give every
 * consumer one resolution path (finding F13): the store tool reads the limit at
 * registration and the guide reads it at call time through this module.
 *
 * Each wrapper takes the connection as a trailing defaulted param per the DI
 * convention, so a caller with a specific connection can pass it through.
 */
/**
 * The advertised thought soft limit. Unlike the wrappers above this one cannot
 * default its connection to `getDb()`: registration may run before `initDb()`
 * in some harnesses, and the default expression would throw outside the guard.
 * So the connection is resolved lazily inside the guard, which keeps the
 * pre-init degradation to config that the db layer used to own.
 */
export function getAdvertisedSoftLimitService(d?: Database): number {
  try {
    return resolveAdvertisedSoftLimit(d ?? getDb())
  } catch {
    return configuredSoftLimit()
  }
}
