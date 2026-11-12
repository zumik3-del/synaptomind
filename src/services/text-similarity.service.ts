import { clamp01 } from '../utils'

export function normalise(s: string): string {
  return s.toLowerCase().replace(/\s+/g, ' ').trim()
}

export function jaccard(a: string, b: string): number {
  const setA = new Set(a.split(/\s+/).filter(Boolean))
  const setB = new Set(b.split(/\s+/).filter(Boolean))
  if (setA.size === 0 && setB.size === 0) return 1
  if (setA.size === 0 || setB.size === 0) return 0
  let overlap = 0
  for (const w of setA) if (setB.has(w)) overlap++
  return overlap / (setA.size + setB.size - overlap)
}

export { clamp01 }

// Raw e5-small cosine is compressed (unrelated pairs ≈0.76–0.80), so thresholds operate on this
// calibrated scale, not on raw similarity. A degenerate band degrades to a step at confidenceFloor.
export function calibrateRelevance(
  similarity: number,
  unrelatedFloor: number,
  confidenceFloor: number
): number {
  const span = confidenceFloor - unrelatedFloor
  if (!(span > 0)) return Number.isFinite(similarity) && similarity >= confidenceFloor ? 1 : 0
  return clamp01((similarity - unrelatedFloor) / span)
}
