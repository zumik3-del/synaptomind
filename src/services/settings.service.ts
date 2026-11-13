import { getThoughtLimitsDB } from '../db/settings'

export function getAdvertisedSoftLimitService(): number {
  return getThoughtLimitsDB().softLimit
}
