const UNSCORABLE = 0

interface ScoredNeighbor {
  id: string
  score: number
}

function cosineSimilarity(a: Float32Array, b: Float32Array): number {
  if (a.length !== b.length) return UNSCORABLE
  let dot = 0
  let normA = 0
  let normB = 0
  for (let i = 0; i < a.length; i++) {
    const x = a[i]
    const y = b[i]
    dot += x * y
    normA += x * x
    normB += y * y
  }
  if (normA === 0 || normB === 0) return UNSCORABLE
  return dot / Math.sqrt(normA * normB)
}

function distanceRow(
  candidates: Array<{ id: string }>,
  embeddings: Float32Array[],
  cache: Map<string, Float32Array>,
  candidateId: string
): Float32Array | null {
  const own = candidates.findIndex(c => c.id === candidateId)
  if (own === -1) return null
  const cached = cache.get(candidateId)
  if (cached) return cached
  const row = new Float32Array(candidates.length)
  for (let j = 0; j < candidates.length; j++) {
    row[j] = j === own ? 1 : cosineSimilarity(embeddings[own], embeddings[j])
  }
  cache.set(candidateId, row)
  return row
}

export function buildInMemoryDistanceLookup(
  candidates: Array<{ id: string }>,
  embeddings: Float32Array[]
): (candidateId: string, topK: number) => Array<{ id: string; distance: number }> {
  const cache = new Map<string, Float32Array>()
  return (candidateId, topK) => {
    const row = distanceRow(candidates, embeddings, cache, candidateId)
    if (!row) return []
    const others: ScoredNeighbor[] = []
    for (let j = 0; j < candidates.length; j++) {
      if (candidates[j].id === candidateId) continue
      others.push({ id: candidates[j].id, score: 1 - row[j] })
    }
    const k =
      Number.isFinite(topK) && topK > 0 ? Math.min(Math.floor(topK), others.length) : others.length
    if (k >= others.length) return others.map(n => ({ id: n.id, distance: n.score }))
    return others
      .sort((a, b) => a.score - b.score)
      .slice(0, k)
      .map(n => ({ id: n.id, distance: n.score }))
  }
}
