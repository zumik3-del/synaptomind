/**
 * Small, dependency-free, layer-neutral helpers shared across services and
 * the policy layer.
 */

/** Clamp `n` into `[0, 1]`; non-finite input (`NaN`, `Infinity`) becomes `0`. */
export function clamp01(n: number): number {
  if (!Number.isFinite(n)) return 0
  return Math.min(1, Math.max(0, n))
}
