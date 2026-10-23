import { expect, test, mock } from 'bun:test'
import { sanitizeRetentionReviewBounds } from './config.retention-review-bounds'

const defaults = { pageSize: 20, importanceFloor: 0.2, minAgeDays: 30 }

test('retention-review config clamps page size and importance floor and falls back for invalid numbers', () => {
  const error = mock(() => {})
  const original = console.error
  console.error = error
  try {
    expect(sanitizeRetentionReviewBounds({ pageSize: 101.8, importanceFloor: -1, minAgeDays: 0 }, defaults))
      .toEqual({ pageSize: 100, importanceFloor: 0, minAgeDays: 30 })
    expect(sanitizeRetentionReviewBounds({ pageSize: 'bad', importanceFloor: Infinity, minAgeDays: undefined }, defaults))
      .toEqual(defaults)
    expect(error).toHaveBeenCalled()
  } finally {
    console.error = original
  }
})

test('valid retention-review config values do not warn', () => {
  const error = mock(() => {})
  const original = console.error
  console.error = error
  try {
    expect(sanitizeRetentionReviewBounds({ pageSize: 15, importanceFloor: 0.4, minAgeDays: 45 }, defaults))
      .toEqual({ pageSize: 15, importanceFloor: 0.4, minAgeDays: 45 })
    expect(error).not.toHaveBeenCalled()
  } finally {
    console.error = original
  }
})
