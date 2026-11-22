import { afterEach, beforeEach, expect, test } from 'bun:test'
import { config, DEFAULTS } from './config'
import { createTestDb } from './test/helpers'
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
  const { softLimit: originalSoft, hardLimitBufferPercent: originalBuffer } = config.thoughts
  try {
    config.thoughts.softLimit = 33
    config.thoughts.hardLimitBufferPercent = 10
    expect(getThoughtLimitsDB().hardLimit).toBe(36)
    config.thoughts.softLimit = 10
    config.thoughts.hardLimitBufferPercent = 5
    expect(getThoughtLimitsDB().hardLimit).toBe(11)
  } finally {
    config.thoughts.softLimit = originalSoft
    config.thoughts.hardLimitBufferPercent = originalBuffer
  }
})

test('stored _meta limit values are ignored — config is the only source', () => {
  writeMeta('thought_soft_limit', '100')
  writeMeta('thought_hard_limit_buffer_percent', '50')
  writeMeta('thought_hard_limit', '5000')

  expect(getThoughtLimitsDB()).toEqual(configuredLimits())
})

test('invalid configured soft limit and buffer fall back to defaults', () => {
  const originalSoft = config.thoughts.softLimit
  const originalBuffer = config.thoughts.hardLimitBufferPercent
  try {
    config.thoughts.softLimit = 0
    config.thoughts.hardLimitBufferPercent = -5
    expect(getThoughtLimitsDB()).toEqual({
      softLimit: DEFAULTS.thoughts.softLimit,
      hardLimit: Math.round(
        DEFAULTS.thoughts.softLimit * (1 + DEFAULTS.thoughts.hardLimitBufferPercent / 100)
      ),
      hardLimitBufferPercent: DEFAULTS.thoughts.hardLimitBufferPercent
    })
  } finally {
    config.thoughts.softLimit = originalSoft
    config.thoughts.hardLimitBufferPercent = originalBuffer
  }
})

test('getThoughtLimitsDB needs no database, before and after closeDb()', () => {
  const original = config.thoughts.softLimit
  try {
    closeDb()
    expect(() => getDb()).toThrow()
    config.thoughts.softLimit = 432
    expect(getThoughtLimitsDB().softLimit).toBe(432)

    createTestDb()
    expect(getThoughtLimitsDB().softLimit).toBe(432)

    closeDb()
    expect(() => getDb()).toThrow()
    expect(getThoughtLimitsDB().softLimit).toBe(432)
  } finally {
    config.thoughts.softLimit = original
  }
})

test('getThoughtLimitsDB reflects the latest configured value on every call (no module-load cache)', () => {
  const original = config.thoughts.softLimit
  try {
    config.thoughts.softLimit = 100
    expect(getThoughtLimitsDB().softLimit).toBe(100)
    config.thoughts.softLimit = 250
    expect(getThoughtLimitsDB().softLimit).toBe(250)
  } finally {
    config.thoughts.softLimit = original
  }
})
