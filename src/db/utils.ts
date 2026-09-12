export function toBit(val?: boolean): number {
  return val ? 1 : 0
}

export function sqlIn(values: readonly unknown[]): string {
  return values.map(() => '?').join(',')
}

/**
 * Canonical key for an unordered pair of thought ids. Ids are UUID-shaped, so
 * `::` is a safe separator (mirrors the convention used by auto-link's
 * `mergeCandidates`).
 */
export function pairKey(a: string, b: string): string {
  return a < b ? `${a}::${b}` : `${b}::${a}`
}
