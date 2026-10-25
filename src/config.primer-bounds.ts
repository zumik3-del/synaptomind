/**
 * Bounds for the two primer knobs (`primer.topN`, `primer.promoteThreshold`).
 *
 * Both knobs are counts, so both must be integers >= 1:
 * - a negative `topN` reaches SQLite as `LIMIT -1`, which means "no limit" -
 *   the architecture_decisions slot then renders EVERY primer instead of the
 *   top N;
 * - a negative `promoteThreshold` makes `hit_count >= threshold` true for
 *   every thought, so every search promotes everything into the always-at-hand
 *   set.
 *
 * The module imports nothing on purpose: the config layer sanitizes the FINAL
 * merged config with it (after the config.json merge AND after the env
 * overrides), and the db layer reuses the clamp for its LIMIT bind (a LIMIT
 * bind must be an integer - `Math.floor`).
 */

/** The two primer knobs; both are counts. */
export interface PrimerBounds {
  topN: number
  promoteThreshold: number
}

/**
 * Clamp a count to an integer >= 1. A non-numeric or non-finite value falls
 * back to `fallback`; a finite number is floored (the LIMIT bind gotcha) and
 * raised to 1 (a count below 1 is not a count).
 */
export function clampPrimerCount(value: unknown, fallback: number): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) return fallback
  const floored = Math.floor(value)
  return floored < 1 ? 1 : floored
}

/**
 * Sanitize one primer knob. A valid count is returned untouched, a count below
 * 1 becomes 1 and a non-numeric or non-finite value falls back to the
 * built-in default. Every fixed value is reported on stderr, in the style the
 * config layer already uses for bad values ("invalid value for ..."), naming
 * both the offending value and the value actually used.
 */
function sanitizePrimerCount(value: unknown, fallback: number, label: string): number {
  // Not provided at all: the built-in default, silently.
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

/**
 * Sanitize both primer knobs of the final merged config. `defaults` holds the
 * built-in values used as the fallback for a non-numeric knob; the defaults
 * themselves are never changed here.
 */
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
