export const RRF_K = 60

export function rrfMerge(lists: string[][]): Array<{ id: string; score: number }> {
  const score = new Map<string, number>()
  for (const list of lists) {
    list.forEach((id, idx) => {
      score.set(id, (score.get(id) ?? 0) + 1 / (RRF_K + idx + 1))
    })
  }
  return [...score.entries()].sort((a, b) => b[1] - a[1]).map(([id, s]) => ({ id, score: s }))
}
