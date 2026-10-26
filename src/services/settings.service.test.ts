import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { config } from '../config'
import { closeDb } from '../db/init'
import { createTestDb } from '../test/helpers'
import { getAdvertisedSoftLimitService } from './settings.service'

// Regression coverage for task #165 (F2/F13): the advertised soft limit has a
// single service resolution path, reads the configuration each time (no stale
// per-session cache) and degrades to config when the DB is not initialised.
// The value itself is config-only since task #2201 (the `_meta` overrides are
// gone), so the cases below drive `config.thoughts.softLimit` directly.
const originalSoftLimit = config.thoughts.softLimit

beforeEach(createTestDb)
afterEach(() => {
  closeDb()
  config.thoughts.softLimit = originalSoftLimit
})

describe('getAdvertisedSoftLimitService', () => {
  test('returns the configured soft limit', () => {
    config.thoughts.softLimit = 432
    expect(getAdvertisedSoftLimitService()).toBe(432)
  })

  test('reflects the latest configured value on every call (no caching)', () => {
    config.thoughts.softLimit = 100
    expect(getAdvertisedSoftLimitService()).toBe(100)
    config.thoughts.softLimit = 250
    expect(getAdvertisedSoftLimitService()).toBe(250)
  })

  test('falls back to config when the DB is not initialised', () => {
    closeDb()
    config.thoughts.softLimit = 777
    expect(getAdvertisedSoftLimitService()).toBe(777)
  })
})
