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
