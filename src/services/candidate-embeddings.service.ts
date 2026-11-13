import type { Database } from 'bun:sqlite'
import { getPendingEmbeddingIds, getThoughtEmbeddingsBatch } from '../db/embeddings'

interface EmbeddableCandidate {
  id: string
  content: string
}

export async function resolveCandidateEmbeddings(
  candidates: EmbeddableCandidate[],
  embed: (texts: string[]) => Promise<Float32Array[]>,
  db: Database
): Promise<Float32Array[]> {
  // Pending must be read FIRST: a row refreshed between the two reads then costs one harmless extra
  // live embed, while the reverse order could score a stale vector.
  const pending = getPendingEmbeddingIds(
    db,
    candidates.map(c => c.id)
  )
  const stored = getThoughtEmbeddingsBatch(
    db,
    candidates.map(c => c.id)
  )
  const missing = candidates.filter(c => !stored.has(c.id) || pending.has(c.id))
  if (missing.length === 0) return candidates.map(c => stored.get(c.id) as Float32Array)

  const generated = await embed(missing.map(c => c.content))
  if (generated.length !== missing.length) {
    throw new Error(
      `embedder returned ${generated.length} vectors for ${missing.length} candidates`
    )
  }
  missing.forEach((candidate, i) => {
    stored.set(candidate.id, generated[i])
  })
  return candidates.map(c => stored.get(c.id) as Float32Array)
}
