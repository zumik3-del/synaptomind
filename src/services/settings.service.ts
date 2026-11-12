import { getThoughtLimitsDB } from '../db/settings'

/**
 * The advertised thought soft limit: the single resolution path for the store
 * tool and the guide (finding F13), while the API/tool layers stay free of
 * direct db access. The computation is config-only (findings F7/#2201), so the
 * wrapper takes no connection and cannot throw before `initDb()`.
 */
export function getAdvertisedSoftLimitService(): number {
  return getThoughtLimitsDB().softLimit
}
