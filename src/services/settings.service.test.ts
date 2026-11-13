import { afterEach, describe, expect, test } from 'bun:test'
import { config } from '../config'
import { getDb } from '../context/container'
import { closeDb } from '../db/init'
import { createTestDb } from '../test/helpers'
import { getAdvertisedSoftLimitService } from './settings.service'

const originalSoftLimit = config.thoughts.softLimit

afterEach(() => {
  closeDb()
  config.thoughts.softLimit = originalSoftLimit
})

describe('getAdvertisedSoftLimitService', () => {
  test('returns the configured soft limit with no DB, on an open DB and after closeDb()', () => {
    closeDb()
    expect(() => getDb()).toThrow()
    config.thoughts.softLimit = 432
    expect(getAdvertisedSoftLimitService()).toBe(432)

    createTestDb()
    expect(getAdvertisedSoftLimitService()).toBe(432)

    closeDb()
    expect(() => getDb()).toThrow()
    expect(getAdvertisedSoftLimitService()).toBe(432)
  })

  test('reflects the latest configured value on every call (no module-load cache)', () => {
    config.thoughts.softLimit = 100
    expect(getAdvertisedSoftLimitService()).toBe(100)
    config.thoughts.softLimit = 250
    expect(getAdvertisedSoftLimitService()).toBe(250)
  })
})
