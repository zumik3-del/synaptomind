// SQLite reads a negative `LIMIT` as "no limit", so an unsanitized `primer.topN` would render every
// primer instead of the top N; a negative `promoteThreshold` promotes on every search.
// Imports nothing on purpose: the config layer and the db LIMIT bind both use these clamps.
export interface PrimerBounds {
  topN: number
  promoteThreshold: number
}

export function clampPrimerCount(value: unknown, fallback: number): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) return fallback
  const floored = Math.floor(value)
  return floored < 1 ? 1 : floored
}

function sanitizePrimerCount(value: unknown, fallback: number, label: string): number {
  if (value === undefined) return fallback
  const numeric = typeof value === 'number' && Number.isFinite(value) ? value : undefined
  const used = numeric === undefined ? fallback : clampPrimerCount(numeric, fallback)
  if (used === numeric) return used
  const origin = numeric === undefined ? ' (default)' : ''
  console.error(
    `[config] invalid value for ${label}: "${String(value)}" (expected an integer >= 1), using ${used}${origin}`
  )
  return used
}

export function sanitizePrimerBounds(primer: unknown, defaults: PrimerBounds): PrimerBounds {
  const section =
    typeof primer === 'object' && primer !== null && !Array.isArray(primer)
      ? (primer as Record<string, unknown>)
      : null
  if (!section) {
    console.error(
      `[config] invalid value for primer: "${String(primer)}" (expected an object with topN and promoteThreshold), using the defaults (topN=${defaults.topN}, promoteThreshold=${defaults.promoteThreshold})`
    )
    return { topN: defaults.topN, promoteThreshold: defaults.promoteThreshold }
  }
  return {
    topN: sanitizePrimerCount(section.topN, defaults.topN, 'primer.topN'),
    promoteThreshold: sanitizePrimerCount(
      section.promoteThreshold,
      defaults.promoteThreshold,
      'primer.promoteThreshold'
    )
  }
}
