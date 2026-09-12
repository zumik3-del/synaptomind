import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { config } from '../config'
import { closeDb } from '../db/init'
import { setThoughtLimits } from '../db/settings'
import { createTestDb } from '../test/helpers'
import { getAdvertisedSoftLimitService } from './settings.service'

// Regression coverage for task #165 (F2/F13): the advertised soft limit has a
// single service resolution path, reads the DB each time (no stale per-session
// cache) and degrades to config when the DB is not initialised.
const originalSoftLimit = config.thoughts.softLimit

beforeEach(createTestDb)
afterEach(() => {
  closeDb()
  config.thoughts.softLimit = originalSoftLimit
})

describe('getAdvertisedSoftLimitService', () => {
  test('returns the DB-backed soft limit', () => {
    setThoughtLimits(432, 20)
    expect(getAdvertisedSoftLimitService()).toBe(432)
  })

  test('reflects the latest persisted value on every call (no caching)', () => {
    setThoughtLimits(100, 20)
    expect(getAdvertisedSoftLimitService()).toBe(100)
    setThoughtLimits(250, 20)
    expect(getAdvertisedSoftLimitService()).toBe(250)
  })

  test('falls back to config when the DB is not initialised', () => {
    closeDb()
    config.thoughts.softLimit = 777
    expect(getAdvertisedSoftLimitService()).toBe(777)
  })
})
