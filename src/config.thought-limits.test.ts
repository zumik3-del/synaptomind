import { afterEach, beforeEach, expect, test } from 'bun:test'
import { config, DEFAULTS } from './config'
import { configFixture, createTestDb } from './test/helpers'
import { getDb } from './db'
import { closeDb } from './db/init'
import { getThoughtLimitsDB } from './config.thought-limits'

beforeEach(createTestDb)
afterEach(closeDb)

function writeMeta(key: string, value: string): void {
  getDb().prepare(`INSERT OR REPLACE INTO _meta (key, value) VALUES (?, ?)`).run(key, value)
}

function configuredLimits(): {
  softLimit: number
  hardLimit: number
  hardLimitBufferPercent: number
} {
  const { softLimit, hardLimitBufferPercent } = config.thoughts
  return {
    softLimit,
    hardLimit: Math.round(softLimit * (1 + hardLimitBufferPercent / 100)),
    hardLimitBufferPercent
  }
}

test('getThoughtLimitsDB returns config defaults with derived hard limit', () => {
  expect(getThoughtLimitsDB()).toEqual({
    softLimit: 600,
    hardLimit: 720,
    hardLimitBufferPercent: 20
  })
})

test('getThoughtLimitsDB uses the configured soft limit and buffer', () => {
  const { softLimit, hardLimitBufferPercent } = config.thoughts
  expect(getThoughtLimitsDB()).toEqual({
    softLimit,
    hardLimit: Math.round(softLimit * (1 + hardLimitBufferPercent / 100)),
    hardLimitBufferPercent
  })
})

test('derived hard limit rounds to the nearest integer', () => {
  const tens = configFixture({
    thoughts: { ...config.thoughts, softLimit: 33, hardLimitBufferPercent: 10 }
  })
  expect(getThoughtLimitsDB(tens).hardLimit).toBe(36)

  const fives = configFixture({
    thoughts: { ...config.thoughts, softLimit: 10, hardLimitBufferPercent: 5 }
  })
  expect(getThoughtLimitsDB(fives).hardLimit).toBe(11)
})

test('stored _meta limit values are ignored — config is the only source', () => {
  writeMeta('thought_soft_limit', '100')
  writeMeta('thought_hard_limit_buffer_percent', '50')
  writeMeta('thought_hard_limit', '5000')

  expect(getThoughtLimitsDB()).toEqual(configuredLimits())
})

test('invalid configured soft limit and buffer fall back to defaults', () => {
  const invalid = configFixture({
    thoughts: { ...config.thoughts, softLimit: 0, hardLimitBufferPercent: -5 }
  })
  expect(getThoughtLimitsDB(invalid)).toEqual({
    softLimit: DEFAULTS.thoughts.softLimit,
    hardLimit: Math.round(
      DEFAULTS.thoughts.softLimit * (1 + DEFAULTS.thoughts.hardLimitBufferPercent / 100)
    ),
    hardLimitBufferPercent: DEFAULTS.thoughts.hardLimitBufferPercent
  })
})

test('getThoughtLimitsDB needs no database, before and after closeDb()', () => {
  const custom = configFixture({ thoughts: { ...config.thoughts, softLimit: 432 } })
  closeDb()
  expect(() => getDb()).toThrow()
  expect(getThoughtLimitsDB(custom).softLimit).toBe(432)

  createTestDb()
  expect(getThoughtLimitsDB(custom).softLimit).toBe(432)

  closeDb()
  expect(() => getDb()).toThrow()
  expect(getThoughtLimitsDB(custom).softLimit).toBe(432)
})

test('getThoughtLimitsDB reflects the supplied value on every call (no module-load cache)', () => {
  expect(
    getThoughtLimitsDB(configFixture({ thoughts: { ...config.thoughts, softLimit: 100 } }))
      .softLimit
  ).toBe(100)
  expect(
    getThoughtLimitsDB(configFixture({ thoughts: { ...config.thoughts, softLimit: 250 } }))
      .softLimit
  ).toBe(250)
})
