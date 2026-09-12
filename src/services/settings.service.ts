import { getAdvertisedSoftLimit as resolveAdvertisedSoftLimit } from '../db/settings'

/**
 * Thin service wrapper for the advertised thought soft limit. Keeps the MCP
 * tool layer free of direct db access (finding F2) and gives every consumer a
 * single resolution path (finding F13): the store tool reads it at
 * registration and the guide reads it at call time through this function.
 */
export function getAdvertisedSoftLimitService(): number {
  return resolveAdvertisedSoftLimit()
}
