/**
 * Shared pure text-similarity helpers.
 *
 * Extracted verbatim from `session-reflection.service.ts` so the placement
 * policy layer can reuse the same near-duplicate signal without importing
 * private service internals (ADR 2026-09-28, P1). No I/O, no state.
 */

/** Normalise a string for fuzzy comparison: lowercase, collapse whitespace. */
export function normalise(s: string): string {
  return s.toLowerCase().replace(/\s+/g, ' ').trim()
}

/** Word-set Jaccard similarity on normalised text. */
export function jaccard(a: string, b: string): number {
  const setA = new Set(a.split(/\s+/).filter(Boolean))
  const setB = new Set(b.split(/\s+/).filter(Boolean))
  if (setA.size === 0 && setB.size === 0) return 1
  if (setA.size === 0 || setB.size === 0) return 0
  let overlap = 0
  for (const w of setA) if (setB.has(w)) overlap++
  return overlap / (setA.size + setB.size - overlap)
}

/** Clamp a possibly non-finite number into `[0, 1]` (`NaN` → `0`). */
export function clamp01(value: number): number {
  if (!Number.isFinite(value)) return 0
  return Math.min(Math.max(value, 0), 1)
}

/**
 * Calibrated cosine relevance on the measured unrelated→strong-match band.
 *
 * The raw e5-small cosine scale is compressed (task #2178 measurement: unrelated
 * query/thought pairs p50 0.7627, p95 0.8002), so a raw similarity is not a
 * usable threshold. This maps `unrelatedFloor` to `0` and `confidenceFloor` to
 * `1`, clamped: `clamp01((similarity - unrelatedFloor) / (confidenceFloor -
 * unrelatedFloor))`.
 *
 * A degenerate band (`confidenceFloor <= unrelatedFloor`, e.g. a misconfigured
 * override) has no scale to interpolate on; it degrades to a step: `1` at or
 * above `confidenceFloor`, `0` below.
 */
export function calibrateRelevance(
  similarity: number,
  unrelatedFloor: number,
  confidenceFloor: number
): number {
  const span = confidenceFloor - unrelatedFloor
  if (!(span > 0)) return Number.isFinite(similarity) && similarity >= confidenceFloor ? 1 : 0
  return clamp01((similarity - unrelatedFloor) / span)
}
