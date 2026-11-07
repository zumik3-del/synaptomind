/**
 * Small, dependency-free, layer-neutral helpers shared across services and
 * the policy layer.
 */
import { createHash } from 'node:crypto'

/** Milliseconds in one day. */
export const MS_PER_DAY = 86_400_000

/** Clamp `n` into `[0, 1]`; non-finite input (`NaN`, `Infinity`) becomes `0`. */
export function clamp01(n: number): number {
  if (!Number.isFinite(n)) return 0
  return Math.min(1, Math.max(0, n))
}

/** Coerce an unknown value into a finite number, or `undefined` when not parseable. */
export function asNumber(value: unknown): number | undefined {
  if (value === undefined || value === null) return undefined
  if (typeof value === 'number') return value
  if (typeof value === 'string') {
    const n = Number(value)
    return Number.isFinite(n) ? n : undefined
  }
  return undefined
}

/** SHA-256 hex digest of `content` scoped to a project (dedupe key). */
export function computeContentHash(content: string, projectId: string): string {
  return createHash('sha256').update(content + projectId).digest('hex')
}

/**
 * Normalize a tag filter: accepts a comma-separated string or an array,
 * trims entries, drops blanks. Returns `undefined` when nothing usable
 * remains so callers can skip the filter entirely.
 */
export function parseTags(raw: string | string[] | undefined): string[] | undefined {
  if (raw === undefined) return undefined
  if (Array.isArray(raw)) return raw.map(t => t.trim()).filter(Boolean)
  const parsed = raw
    .split(',')
    .map(t => t.trim())
    .filter(Boolean)
  return parsed.length > 0 ? parsed : undefined
}
