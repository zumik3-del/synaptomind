/** Bounds for retention-review configuration, sanitized after all overrides. */
export interface RetentionReviewBounds {
  minAgeDays: number
  importanceFloor: number
  pageSize: number
}

function sanitizeNumber(
  value: unknown,
  fallback: number,
  label: string,
  expected: string,
  normalize: (value: number) => number
): number {
  if (value === undefined) return fallback
  const numeric = typeof value === 'number' && Number.isFinite(value) ? value : undefined
  const used = numeric === undefined ? fallback : normalize(numeric)
  if (used === numeric) return used
  const origin = numeric === undefined ? ' (default)' : ''
  console.error(`[config] invalid value for ${label}: "${String(value)}" (expected ${expected}), using ${used}${origin}`)
  return used
}

function clampPageSize(value: number): number {
  return Math.min(100, Math.max(1, Math.floor(value)))
}

function clampImportanceFloor(value: number): number {
  return Math.min(1, Math.max(0, value))
}

function positiveMinAgeDays(value: number): number {
  return value > 0 ? value : 30
}

export function sanitizeRetentionReviewBounds(
  retentionReview: unknown,
  defaults: RetentionReviewBounds
): RetentionReviewBounds {
  const section =
    typeof retentionReview === 'object' && retentionReview !== null && !Array.isArray(retentionReview)
      ? (retentionReview as Record<string, unknown>)
      : null
  if (!section) {
    console.error(`[config] invalid value for retentionReview: "${String(retentionReview)}" (expected an object), using the defaults`)
    return { ...defaults }
  }
  return {
    pageSize: sanitizeNumber(section.pageSize, defaults.pageSize, 'retentionReview.pageSize', 'an integer in [1,100]', clampPageSize),
    importanceFloor: sanitizeNumber(section.importanceFloor, defaults.importanceFloor, 'retentionReview.importanceFloor', 'a number in [0,1]', clampImportanceFloor),
    minAgeDays: sanitizeNumber(section.minAgeDays, defaults.minAgeDays, 'retentionReview.minAgeDays', 'a number greater than 0', positiveMinAgeDays)
  }
}
